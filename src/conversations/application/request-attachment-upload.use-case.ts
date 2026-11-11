import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceStorage } from '../../spaces/application/space-storage.js';
import { SpaceStorageUsage } from '../../spaces/application/space-storage-usage.js';
import {
  PRESIGNED_URL_TTL_SECONDS,
  STORAGE_LOCK_TIMEOUT_MS,
  UPLOAD_WINDOW_MS,
} from '../../storage/application/object-uploads.js';
import { ObjectStore } from '../../storage/application/ports/object-store.js';
import { lockTimeoutAsBusy } from '../../storage/application/storage-errors.js';
import { attachmentUploadKey } from '../domain/attachment-keys.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { ConversationAttachment } from '../domain/conversation-attachment.js';
import { ConversationAttachmentRepository } from '../domain/conversation-attachment.repository.js';
import {
  assertSpaceFits,
  attachmentIdConflict,
  conversationNotFound,
} from '../domain/conversation-errors.js';
import type { Conversation } from '../domain/conversation.js';
import { ConversationAccess } from './conversation-access.js';
import { attachmentView, type AttachmentView } from './dto/attachment-view.js';

export type AttachmentUploadInput = {
  /** UUID v7 from the device (part of the encryption AD): repeating the same request is idempotent. */
  id: string;
  /** Must be the current version of the conversation key. */
  keyVersion: number;
  /** Exact size of the encrypted blob (≤ 100 MiB). */
  sizeBytes: number;
  /** sha256 (lowercase hex) of the encrypted blob: S3 refuses other bytes at the PUT. */
  sha256: string;
};

export type AttachmentUpload = {
  url: string;
  /** Sent verbatim with the PUT (part of the signature: size, checksum, `stage=upload` tag). */
  headers: Record<string, string>;
  expiresAt: Date;
};

export type AttachmentUploadResult = {
  view: AttachmentView;
  /** Null when the attachment is already committed (nothing to upload). */
  upload: AttachmentUpload | null;
  created: boolean;
};

// Intenção de envio de um anexo (spec conversations §4.4; mesmo fluxo do storage, índice próprio):
// 1. formato antes de travar nada (id v7, versão, sha256, tamanho ≤ 100 MiB: 422 `attachment-too-large`);
// 2. no unit of work (`lock_timeout` de 10 s, `STORAGE_LOCK_TIMEOUT_MS`: espera maior = 409 `storage-busy`), na ordem
//    global: espaço `FOR SHARE` (`SpaceStorage.lockQuota`, como o envio de mensagem) -> assunto `FOR UPDATE`. Só
//    participante (token de usuário) ou o executor (token de Hub); o resto, o mesmo 404 `conversation-not-found`;
// 3. o mesmo pedido de novo (id, assunto, quem envia, versão, tamanho e sha256 iguais): pendente = renova a janela e
//    devolve uma URL nova (200); confirmado = 200 sem URL. Qualquer outra coisa com o id (ou um id que o escopo nem
//    vê: `insertIfAbsent` false) = 409 `attachment-id-conflict`;
// 4. troca de chave pendente / versão diferente da atual: 409; grava a reserva (`pending`, janela de 24 h no relógio do
//    banco). DEPOIS de gravar lê o uso do espaço inteiro (porta `SpaceStorageUsage`: backup, mensagens e anexos com as
//    reservas vivas; o trigger da projeção travou a linha do espaço no contador, então intenções e mensagens do mesmo
//    espaço se serializam e cada uma lê a anterior) e confere: senão 422 `space-storage-full` (`missingBytes`);
// 5. depois do COMMIT (nenhuma chamada ao S3 sob as travas), assina o PUT da chave provisória, preso ao tamanho e ao
//    sha256 declarados (15 min).
@Injectable()
export class RequestAttachmentUploadUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly spaceStorage: SpaceStorage,
    private readonly usage: SpaceStorageUsage,
    private readonly attachments: ConversationAttachmentRepository,
    private readonly store: ObjectStore,
    private readonly uow: UnitOfWork,
  ) {}

  async byUser(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    input: AttachmentUploadInput,
  ): Promise<AttachmentUploadResult> {
    ConversationAttachment.assertRequest(input);
    return this.run(
      async () => {
        await this.uow.setContext({ userId: actor.userId });
        const scope = await this.access.userScope(spaceId, actor);
        return { scope, spaceId };
      },
      conversationId,
      input,
    );
  }

  async byHub(
    hub: HubAuthContext,
    conversationId: string,
    input: AttachmentUploadInput,
  ): Promise<AttachmentUploadResult> {
    ConversationAttachment.assertRequest(input);
    return this.run(
      async () => {
        await this.uow.setContext({ hubId: hub.hubId });
        // Sem trava aqui: só para achar a organização e o espaço (imutáveis) antes de travar o espaço.
        const { scope, conversation } = await this.access.findForHub(
          hub.hubId,
          conversationId,
        );
        return { scope, spaceId: conversation.spaceId };
      },
      conversationId,
      input,
    );
  }

  private async run(
    resolve: () => Promise<{ scope: ConversationScope; spaceId: string }>,
    conversationId: string,
    input: AttachmentUploadInput,
  ): Promise<AttachmentUploadResult> {
    const result = await this.uow
      .run(async () => {
        await this.uow.setLockTimeout(STORAGE_LOCK_TIMEOUT_MS);
        const { scope, spaceId } = await resolve();
        const quotaBytes = await this.spaceStorage.lockQuota(
          scope.organizationId,
          spaceId,
        );
        if (quotaBytes === null) throw conversationNotFound();
        const conversation = await this.access.lock(
          scope,
          conversationId,
          spaceId,
        );
        return this.reserve(scope, conversation, quotaBytes, input);
      })
      .catch((error: unknown) => {
        throw lockTimeoutAsBusy(error);
      });
    const a = result.attachment;
    if (a.status !== 'pending') {
      return { view: attachmentView(a), upload: null, created: false };
    }
    // From a clock read before signing: the URL works at least until the announced `expiresAt`.
    const expiresAt = new Date(Date.now() + PRESIGNED_URL_TTL_SECONDS * 1000);
    const { url, headers } = await this.store.presignPut(
      attachmentUploadKey(a),
      {
        sizeBytes: a.sizeBytes,
        sha256Hex: a.sha256,
        expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
      },
    );
    return {
      view: attachmentView(a),
      upload: { url, headers, expiresAt },
      created: result.created,
    };
  }

  private async reserve(
    scope: ConversationScope,
    conversation: Conversation,
    quotaBytes: number,
    input: AttachmentUploadInput,
  ): Promise<{ attachment: ConversationAttachment; created: boolean }> {
    // Attachment routes are a person's or the executor Hub's; the cloud (reserve executor) never uploads.
    const uploader = scope.actor;
    if (uploader.kind === 'cloud') throw conversationNotFound();
    const now = await this.attachments.databaseNow();
    const candidate = ConversationAttachment.create({
      id: input.id,
      organizationId: scope.organizationId,
      spaceId: conversation.spaceId,
      conversationId: conversation.id,
      uploader,
      messageId: null,
      keyVersion: input.keyVersion,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      uploadExpiresAt: new Date(now.getTime() + UPLOAD_WINDOW_MS),
    });

    const existing = await this.attachments.findById(scope, candidate.id, {
      withDeleted: true,
    });
    if (existing) {
      if (!existing.isSameRequest(candidate) || existing.deletedAt) {
        throw attachmentIdConflict();
      }
      if (existing.status !== 'pending') {
        if (existing.status === 'purged') throw attachmentIdConflict();
        return { attachment: existing, created: false };
      }
      conversation.assertCanWrite(existing.keyVersion);
      existing.renew(candidate.uploadExpiresAt);
      await this.attachments.save(scope, existing);
      await this.assertFits(scope, conversation, quotaBytes);
      return { attachment: existing, created: false };
    }

    conversation.assertCanWrite(candidate.keyVersion);
    if (!(await this.attachments.insertIfAbsent(scope, candidate))) {
      throw attachmentIdConflict();
    }
    await this.assertFits(scope, conversation, quotaBytes);
    return { attachment: candidate, created: true };
  }

  private async assertFits(
    scope: ConversationScope,
    conversation: Conversation,
    quotaBytes: number,
  ): Promise<void> {
    assertSpaceFits(
      quotaBytes,
      await this.usage.usedBytes(scope.organizationId, conversation.spaceId),
    );
  }
}
