import { Injectable } from '@nestjs/common';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import {
  conversationNotFound,
  messageNotFound,
} from '../domain/conversation-errors.js';
import { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import { ConversationAccess } from './conversation-access.js';
import { messageView, type MessageView } from './dto/message-view.js';

// Caixa de entrada (spec conversations §4.3): SÓ o Hub executor confirma (`ack`) que pegou uma mensagem; o backend vê
// só isso e a hora (relógio do banco). Hub que não é o executor: 404 `conversation-not-found` (o RLS nem mostra o
// assunto). Mensagem inexistente, de outro assunto ou apagada: 404 `message-not-found`. Confirmar de novo devolve a
// mesma resposta (a primeira confirmação vale). Grava QUAL Hub confirmou (`ackedByHubId`): se ele deixar de ser executor
// sem responder, a mensagem volta a `pending` (`requeueAckedBy`). Contrato do Hub: só executa depois do 200 do ack. Lock: só o assunto (`FOR NO KEY UPDATE`, como o envio: espera a troca de
// executor, que trava `FOR UPDATE`, mas não a cópia no S3 de uma confirmação de anexo).
@Injectable()
export class AckMessageUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly messages: ConversationMessageRepository,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    hub: HubAuthContext,
    conversationId: string,
    messageId: string,
  ): Promise<MessageView> {
    return this.uow.run(async () => {
      await this.uow.setContext({ hubId: hub.hubId });
      const { scope, conversation } = await this.access.lockForHub(
        hub.hubId,
        conversationId,
        'no-key-update',
      );
      if (!conversation.isExecutor(hub.hubId)) throw conversationNotFound();
      const message = await this.messages.findById(scope, messageId, {
        withDeleted: true,
      });
      if (
        !message ||
        message.conversationId !== conversation.id ||
        message.deletedAt
      ) {
        throw messageNotFound();
      }
      if (message.pending) {
        message.ack(await this.messages.databaseNow(), hub.hubId);
        await this.messages.save(scope, message);
      }
      return messageView(message);
    });
  }
}
