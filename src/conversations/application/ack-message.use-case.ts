import { Injectable } from '@nestjs/common';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
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
// mesma resposta (a primeira confirmação vale). Já confirmada pela NUVEM (executor de reserva, spec active-cloud §4.3):
// o mesmo 404 `message-not-found` (o Hub descarta, nunca executa de novo). Grava QUAL Hub confirmou (`ackedByHubId`): se ele deixar de ser executor
// sem responder, a mensagem volta a `pending` (`requeueAckedBy`). Contrato do Hub: só executa depois do 200 do ack. Lock: só o assunto (`FOR NO KEY UPDATE`, como o envio: espera a troca de
// executor, que trava `FOR UPDATE`, mas não a cópia no S3 de uma confirmação de anexo).
// Hub `pc` (o agente, spec pc-agent §5.3): o ack vale por `AGENT_ACK_LEASE_MS` (`acked_lease_until` = `acked_at` + 15
// min, relógio do banco); sem resposta dele até lá, a varredura (`AgentLeaseSweepJob`) devolve a mensagem à fila. O ack
// repetido não renova (renovar = passo do cérebro ou `POST .../lease`, `AgentTurn.renewLease`).
@Injectable()
export class AckMessageUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly messages: ConversationMessageRepository,
    private readonly hubs: HubDirectory,
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
      // Taken by the cloud (reserve executor) first: the Hub must not run it too (same 404 = discard).
      if (
        !message ||
        message.conversationId !== conversation.id ||
        message.deletedAt ||
        message.ackedByCloud
      ) {
        throw messageNotFound();
      }
      if (message.pending) {
        const agentLease = (await this.hubs.kindOf(hub.hubId)) === 'pc';
        message.ack(
          await this.messages.databaseNow(),
          { kind: 'hub', hubId: hub.hubId },
          { agentLease },
        );
        await this.messages.save(scope, message);
      }
      return messageView(message);
    });
  }
}
