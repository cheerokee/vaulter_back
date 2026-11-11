import { Injectable } from '@nestjs/common';
import {
  CloudReservePendingHooks,
  type CloudReservePendingContext,
} from '../../shared/application/cloud-reserve-pending-hooks.js';
import { ServerKeyCopyCheck } from '../../shared/application/server-key-copy-check.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import type { Conversation } from '../domain/conversation.js';

// As peças da nuvem de reserva (spec active-cloud §4.3) que os casos de uso dos assuntos compartilham:
// - as cópias da chave do assunto para a chave do servidor: conferidas (abrem com a chave do servidor, pela porta
//   `ServerKeyCopyCheck` que o `cloud` registra; 422 `server-copy-invalid`) antes de gravar, e APAGADAS (não lápide:
//   material de chave que o servidor abre, que nenhum feed entrega) quando a reserva cai;
// - quando a reserva cai, o que a nuvem confirmou sem responder volta a `pending` (como um Hub que deixa de ser
//   executor: `requeueAckedBy`);
// - o sinal "mensagem pendente num assunto com reserva" (`CloudReservePendingHooks`), emitido na mesma transação.
// PRÉ-CONDIÇÃO de tudo: dentro do UnitOfWork.run, com o assunto travado, no escopo de um PARTICIPANTE (nunca o da nuvem,
// que não grava cópias e deixa de ver o assunto quando a reserva cai).
@Injectable()
export class ConversationCloudReserve {
  constructor(
    private readonly grants: ConversationKeyGrantRepository,
    private readonly messages: ConversationMessageRepository,
    private readonly serverCopies: ServerKeyCopyCheck,
    private readonly pending: CloudReservePendingHooks,
  ) {}

  /** Every copy opens with the server key (else 422 `server-copy-invalid`); nothing is written here. */
  async assertServerCopies(copies: readonly string[]): Promise<void> {
    for (const copy of copies) await this.serverCopies.assertOpens(copy);
  }

  /** Stores the server copy of `keyVersion` (already checked with `assertServerCopies`). */
  async putServerCopy(
    scope: ConversationScope,
    conversationId: string,
    keyVersion: number,
    wrappedKey: string,
  ): Promise<void> {
    await this.grants.put(scope, conversationId, {
      keyVersion,
      recipient: { kind: 'cloud' },
      wrappedKey,
    });
  }

  /**
   * The reserve went off (owner declined, space left the active cloud, conversation tombstoned): deletes the server
   * copies and requeues what the cloud acknowledged without answering. Returns how many copies were deleted.
   */
  async dropServerSide(
    scope: ConversationScope,
    conversation: Conversation,
  ): Promise<number> {
    const deleted = await this.grants.deleteServerCopies(
      scope,
      conversation.id,
    );
    await this.messages.requeueAckedBy(scope, conversation.id, {
      kind: 'cloud',
    });
    return deleted;
  }

  /** Messages back in the queue (an old executor's acks): with the reserve on, the cloud may take them. */
  async requeued(conversation: Conversation, messageIds: readonly string[]) {
    for (const messageId of messageIds) {
      await this.signal(conversation, messageId, 'requeued');
    }
  }

  /** A pending message the cloud may take (only with the reserve on; else nothing). */
  async signal(
    conversation: Conversation,
    messageId: string,
    reason: CloudReservePendingContext['reason'],
  ): Promise<void> {
    if (!conversation.isCloudExecutor()) return;
    await this.pending.run({
      organizationId: conversation.organizationId,
      spaceId: conversation.spaceId,
      conversationId: conversation.id,
      messageId,
      reason,
    });
  }
}
