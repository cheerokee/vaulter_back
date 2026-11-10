import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { STORAGE_LOCK_TIMEOUT_MS } from '../../storage/application/object-uploads.js';
import { lockTimeoutAsBusy } from '../../storage/application/storage-errors.js';
import { sameActor } from '../domain/conversation-actor.js';
import {
  attachmentNotFound,
  notConversationOwner,
} from '../domain/conversation-errors.js';
import { ConversationAttachmentRepository } from '../domain/conversation-attachment.repository.js';
import {
  ConversationAccess,
  type ScopedConversation,
} from './conversation-access.js';

// Apagar um anexo (spec conversations §4.3–4.4.1; como a mensagem): só quem o enviou (a pessoa, ou o Hub executor);
// outro participante: 403 `not-conversation-owner`. Apagar = lápide (relógio do banco): confirmado vira lixeira (conta
// no uso e na lixeira do espaço; o S3 fica 30 dias, até a retenção ou o dono esvaziar a lixeira do assunto); pendente
// solta a reserva e não confirma mais. A mensagem cita o anexo dentro do corpo cifrado (o backend não sabe quais), então
// o app apaga a mensagem E os anexos dela. Apagar de novo: 204. Inexistente ou de outro assunto: 404
// `attachment-not-found`. Locks: assunto FOR UPDATE -> anexo FOR UPDATE (a trava do objeto; uma confirmação em
// andamento segura o assunto FOR SHARE: espera até o `lock_timeout` do storage, 409 `storage-busy`).
@Injectable()
export class DeleteAttachmentUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly attachments: ConversationAttachmentRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async byUser(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<void> {
    try {
      await this.uow.run(async () => {
        await this.uow.setContext({ userId: actor.userId });
        await this.uow.setLockTimeout(STORAGE_LOCK_TIMEOUT_MS);
        await this.remove(
          await this.access.lockForUser(spaceId, conversationId, actor.userId),
          attachmentId,
        );
      });
    } catch (error) {
      throw lockTimeoutAsBusy(error);
    }
  }

  async byHub(
    hub: HubAuthContext,
    conversationId: string,
    attachmentId: string,
  ): Promise<void> {
    try {
      await this.uow.run(async () => {
        await this.uow.setContext({ hubId: hub.hubId });
        await this.uow.setLockTimeout(STORAGE_LOCK_TIMEOUT_MS);
        await this.remove(
          await this.access.lockForHub(hub.hubId, conversationId),
          attachmentId,
        );
      });
    } catch (error) {
      throw lockTimeoutAsBusy(error);
    }
  }

  private async remove(
    { scope, conversation }: ScopedConversation,
    attachmentId: string,
  ): Promise<void> {
    const attachment = await this.attachments.lockById(scope, attachmentId);
    if (!attachment || attachment.conversationId !== conversation.id) {
      throw attachmentNotFound();
    }
    if (!sameActor(attachment.uploader, scope.actor)) {
      throw notConversationOwner();
    }
    if (attachment.deletedAt) return;
    attachment.tombstone(await this.attachments.databaseNow());
    await this.attachments.save(scope, attachment);
  }
}
