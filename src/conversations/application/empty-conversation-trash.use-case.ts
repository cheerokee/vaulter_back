import { Injectable, Logger } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { STORAGE_LOCK_TIMEOUT_MS } from '../../storage/application/object-uploads.js';
import { ObjectStore } from '../../storage/application/ports/object-store.js';
import { lockTimeoutAsBusy } from '../../storage/application/storage-errors.js';
import {
  ConversationAttachmentRepository,
  type PurgedAttachment,
} from '../domain/conversation-attachment.repository.js';
import { MAX_CONVERSATION_PURGE_ATTACHMENTS } from '../domain/conversation-limits.js';
import { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import {
  bytesOfAttachments,
  removePurgedAttachments,
} from './attachment-bucket.js';
import { ConversationAccess } from './conversation-access.js';

export type EmptyConversationTrashResult = {
  purgedMessages: number;
  purgedAttachments: number;
  /** Encrypted bytes that left the space usage (message bodies + attachments). */
  purgedBytes: number;
  /** Attachments still in the trash: the app repeats the request while this is above 0. */
  remainingAttachments: number;
};

// Esvaziar a lixeira DO ASSUNTO (spec conversations §4.4.1): o esvaziar do Gestor (backup do espaço) não alcança
// assunto privado de que ele não participa; aqui é o DONO do assunto, com reautenticação, como no espaço. Ordem:
// 1. acesso sem trava: não participante (inclusive o Gestor do espaço) = 404 `conversation-not-found`; participante
//    que não é o dono = 403 `not-conversation-owner` (sem gastar o Argon2);
// 2. reautenticação (`CurrentAuthProofVerifier`, 422 `current-auth-proof-invalid`) ANTES de qualquer gravação;
// 3. no unit of work (`lock_timeout` do storage: 409 `storage-busy`): assunto FOR UPDATE (dono conferido de novo) ->
//    corpos das mensagens com lápide zerados (todos; o trigger tira os bytes do uso e da lixeira) -> até 1000 anexos
//    com lápide `purged` (FOR UPDATE em ordem de id, marca do diário renovada) -> auditoria `conversation.trash_emptied`
//    (só contagens, só se apagou algo). Nunca trava o espaço (a ordem é espaço -> assunto -> contador);
// 4. depois do COMMIT, `DeleteObjects` em lote no S3 (o que não sai fica com a marca para a varredura).
// Só a lixeira deste assunto: mensagens e anexos vivos nunca são tocados. Um pedido que não apagou nada responde
// `remainingAttachments: 0` (o laço do app sempre para).
@Injectable()
export class EmptyConversationTrashUseCase {
  private readonly logger = new Logger(EmptyConversationTrashUseCase.name);

  constructor(
    private readonly access: ConversationAccess,
    private readonly verifier: CurrentAuthProofVerifier,
    private readonly messages: ConversationMessageRepository,
    private readonly attachments: ConversationAttachmentRepository,
    private readonly store: ObjectStore,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    currentAuthProof: string,
  ): Promise<EmptyConversationTrashResult> {
    const { userId } = actor;
    const { conversation: seen } = await this.access.findForUser(
      spaceId,
      conversationId,
      actor,
    );
    seen.assertOwner(userId);
    await this.verifier.verify(userId, currentAuthProof);
    let committed: {
      messages: { messages: number; bytes: number };
      purged: PurgedAttachment[];
      remainingAttachments: number;
    };
    try {
      committed = await this.uow.run(async () => {
        await this.uow.setContext({ userId });
        await this.uow.setLockTimeout(STORAGE_LOCK_TIMEOUT_MS);
        const { scope, conversation } = await this.access.lockForUser(
          spaceId,
          conversationId,
          actor,
        );
        conversation.assertOwner(userId);
        const messages = await this.messages.purgeTrash(scope, conversation.id);
        const purged = await this.attachments.purgeTrash(
          scope,
          conversation.id,
          MAX_CONVERSATION_PURGE_ATTACHMENTS,
        );
        const remaining = await this.attachments.trashCount(
          scope,
          conversation.id,
        );
        const progressed = messages.messages > 0 || purged.length > 0;
        if (progressed) {
          await this.audit.record({
            organizationId: conversation.organizationId,
            userId,
            action: 'conversation.trash_emptied',
            metadata: {
              conversationId: conversation.id,
              spaceId: conversation.spaceId,
              purgedMessages: messages.messages,
              purgedAttachments: purged.length,
              purgedBytes: messages.bytes + bytesOfAttachments(purged),
            },
          });
        }
        return {
          messages,
          purged,
          remainingAttachments: progressed ? remaining : 0,
        };
      });
    } catch (error) {
      throw lockTimeoutAsBusy(error);
    }
    await removePurgedAttachments(this.store, committed.purged, this.logger);
    return {
      purgedMessages: committed.messages.messages,
      purgedAttachments: committed.purged.length,
      purgedBytes:
        committed.messages.bytes + bytesOfAttachments(committed.purged),
      remainingAttachments: committed.remainingAttachments,
    };
  }
}
