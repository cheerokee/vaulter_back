import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { assertStillMarked } from '../../storage/application/journal.js';
import {
  INDEX_TAIL_TIMEOUT_MS,
  isUploadedAsDeclared,
  STORAGE_LOCK_TIMEOUT_MS,
} from '../../storage/application/object-uploads.js';
import { ObjectStore } from '../../storage/application/ports/object-store.js';
import { lockTimeoutAsBusy } from '../../storage/application/storage-errors.js';
import {
  attachmentKey,
  attachmentUploadKey,
} from '../domain/attachment-keys.js';
import {
  sameActor,
  type ConversationScope,
} from '../domain/conversation-actor.js';
import { ConversationAttachmentRepository } from '../domain/conversation-attachment.repository.js';
import {
  attachmentNotFound,
  attachmentUploadMismatch,
} from '../domain/conversation-errors.js';
import type { MarkedAttachmentRef } from '../domain/conversation-attachment.repository.js';
import { ConversationAttachmentHealer } from './attachment-healer.js';
import { ConversationAccess } from './conversation-access.js';
import { attachmentView, type AttachmentView } from './dto/attachment-view.js';

type Resolved = { scope: ConversationScope; spaceId: string };

// Confirmação do envio de um anexo (spec conversations §4.4; as regras do diário e do reparo são as do storage,
// CLAUDE.md "Módulo storage"), idempotente:
// 1. DIÁRIO antes de tudo, numa transação curta própria (confirmada antes do unit of work que grava no S3; nunca uma
//    segunda conexão do pool enquanto ele segura a dele): depois da checagem de acesso (participante ou executor), marca
//    só o anexo pendente de QUEM confirma, renovando `s3_write_started_at` para o relógio do banco;
// 2. no unit of work (`lock_timeout` de 10 s: 409 `storage-busy`): assunto `FOR KEY SHARE` (só lê o estado da chave
//    durante a cópia no S3: troca de chave, saída e troca de executor, que travam `FOR UPDATE`, esperam a cópia;
//    mensagens e acks travam `FOR NO KEY UPDATE`, que é compatível, e outras confirmações também não esperam; veja
//    `ConversationLockMode`) -> linha do anexo `FOR UPDATE` (a "trava do objeto"). Anexo de outro
//    assunto, de outro remetente, fora da janela de 24 h ou inexistente: 404 `attachment-not-found`; já confirmado: a
//    mesma resposta, nada copiado. Troca de chave pendente / versão velha: 409 (podem ter mudado depois da intenção);
// 3. HEAD do provisório: tamanho e sha256 iguais aos declarados, senão 422 `upload-mismatch` (nada entra no índice);
// 4. reconfere a marca desta tentativa sob a trava (sumiu = a varredura limpou: 409 `storage-busy`, repetível): nenhuma
//    gravação no S3 sem marca. Repara a chave final (cópia de uma tentativa anterior que caiu antes do COMMIT), copia o
//    provisório para a chave final dentro do S3 e grava `committed` com a versão do S3; a cauda até o COMMIT é limitada
//    (`limitRemainingTime(INDEX_TAIL_TIMEOUT_MS)`), como no backup;
// 5. se o unit of work rejeitar depois de começar a gravar no S3 (inclusive COMMIT incerto), o anexo é reparado numa
//    transação nova, no contexto do reparo (só o que o índice não referencia sai). A marca NUNCA é limpa aqui: só a
//    varredura `storage:reconcile`, por idade, depois de reparar.
// Um pedido confirma UM anexo (≤ 100 MiB): o teto de bytes por confirmação do storage (5 GiB) vale trivialmente.
@Injectable()
export class ConfirmAttachmentUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly attachments: ConversationAttachmentRepository,
    private readonly store: ObjectStore,
    private readonly healer: ConversationAttachmentHealer,
    private readonly uow: UnitOfWork,
  ) {}

  async byUser(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<AttachmentView> {
    return this.execute(
      async (locking) => {
        await this.uow.setContext({ userId: actor.userId });
        if (!locking) {
          const { scope } = await this.access.findForUser(
            spaceId,
            conversationId,
            actor.userId,
          );
          return { scope, spaceId };
        }
        return {
          scope: await this.access.userScope(spaceId, actor.userId),
          spaceId,
        };
      },
      conversationId,
      attachmentId,
    );
  }

  async byHub(
    hub: HubAuthContext,
    conversationId: string,
    attachmentId: string,
  ): Promise<AttachmentView> {
    return this.execute(
      async () => {
        await this.uow.setContext({ hubId: hub.hubId });
        const { scope, conversation } = await this.access.findForHub(
          hub.hubId,
          conversationId,
        );
        return { scope, spaceId: conversation.spaceId };
      },
      conversationId,
      attachmentId,
    );
  }

  private async execute(
    resolve: (locking: boolean) => Promise<Resolved>,
    conversationId: string,
    attachmentId: string,
  ): Promise<AttachmentView> {
    const writing: MarkedAttachmentRef[] = [];
    try {
      const mark = await this.uow.run(async () => {
        await this.uow.setLockTimeout(STORAGE_LOCK_TIMEOUT_MS);
        const { scope } = await resolve(false);
        return this.attachments.markWrite(scope, attachmentId, scope.actor);
      });
      return await this.uow.run(async () => {
        await this.uow.setLockTimeout(STORAGE_LOCK_TIMEOUT_MS);
        const { scope, spaceId } = await resolve(true);
        const conversation = await this.access.lock(
          scope,
          conversationId,
          spaceId,
          'key-share',
        );
        const a = await this.attachments.lockById(scope, attachmentId);
        if (
          !a ||
          a.conversationId !== conversation.id ||
          !sameActor(a.uploader, scope.actor)
        ) {
          throw attachmentNotFound();
        }
        if (a.status === 'committed' && !a.deletedAt) return attachmentView(a);
        if (!a.isConfirmable(await this.attachments.databaseNow())) {
          throw attachmentNotFound();
        }
        conversation.assertCanWrite(a.keyVersion);
        if (
          !isUploadedAsDeclared(
            await this.store.head(attachmentUploadKey(a)),
            a.sizeBytes,
            a.sha256,
          )
        ) {
          throw attachmentUploadMismatch(a.id);
        }

        const mine = new Map<string, Date>(mark ? [[a.id, mark]] : []);
        const current = await this.attachments.writeMark(scope, a.id);
        assertStillMarked(
          mine,
          new Map<string, Date>(current ? [[a.id, current]] : []),
          [a.id],
        );
        writing.push({ organizationId: a.organizationId, attachmentId: a.id });
        // Uma tentativa anterior pode ter copiado sem o COMMIT: a chave final de um pendente fica vazia antes da cópia.
        await this.healer.heal(a);
        const { versionId } = await this.store.copy(
          attachmentUploadKey(a),
          attachmentKey(a),
        );
        a.commit(versionId);
        await this.uow.limitRemainingTime(INDEX_TAIL_TIMEOUT_MS);
        await this.attachments.save(scope, a);
        return attachmentView(a);
      });
    } catch (error) {
      if (writing.length > 0) await this.healer.repair(writing);
      throw lockTimeoutAsBusy(error);
    }
  }
}
