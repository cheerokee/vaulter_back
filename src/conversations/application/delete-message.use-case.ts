import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { messageNotFound } from '../domain/conversation-errors.js';
import { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import {
  ConversationAccess,
  type ScopedConversation,
} from './conversation-access.js';

// Apagar mensagem (spec conversations §4.2–4.3): cada um apaga só AS PRÓPRIAS (a pessoa as dela, o Hub executor as
// dele); a de outro: 403 `not-conversation-owner`. Apagar = lápide (relógio do banco); o corpo cifrado fica 30 dias
// (retenção) e passa a contar como lixeira no uso do espaço. Apagar de novo: nada muda (204). Vale também com troca
// de chave pendente (como no backup). Inexistente ou de outro assunto: 404 `message-not-found`. Lock: só o assunto.
@Injectable()
export class DeleteMessageUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly messages: ConversationMessageRepository,
    private readonly uow: UnitOfWork,
  ) {}

  byUser(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      await this.remove(
        await this.access.lockForUser(spaceId, conversationId, actor),
        messageId,
      );
    });
  }

  byHub(
    hub: HubAuthContext,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    return this.uow.run(async () => {
      await this.uow.setContext({ hubId: hub.hubId });
      await this.remove(
        await this.access.lockForHub(hub.hubId, conversationId),
        messageId,
      );
    });
  }

  private async remove(
    { scope, conversation }: ScopedConversation,
    messageId: string,
  ): Promise<void> {
    const message = await this.messages.findById(scope, messageId, {
      withDeleted: true,
    });
    if (!message || message.conversationId !== conversation.id) {
      throw messageNotFound();
    }
    message.assertAuthor(scope.actor);
    if (message.deletedAt) return;
    message.tombstone(await this.messages.databaseNow());
    await this.messages.save(scope, message);
  }
}
