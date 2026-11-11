import { Injectable } from '@nestjs/common';
import type { CloudReservePendingContext } from '../../../shared/application/cloud-reserve-pending-hooks.js';
import { JobQueue } from '../../../shared/application/job-queue.js';
import { CLOUD_FALLBACK_AFTER_MS } from '../../domain/responder.js';

/** Answer the pending messages of one conversation, in order (`AnswerConversationJob`). */
export const ANSWER_CONVERSATION_QUEUE = 'cloud.answer-conversation';

export type AnswerConversationPayload = {
  organizationId: string;
  spaceId: string;
  conversationId: string;
};

const singletonKey = (conversationId: string) =>
  `conversation:${conversationId}`;

// A fila das respostas da nuvem: fila com chave (`oneJobPerKey`, política `stately`): por assunto, UMA tarefa à espera e
// no máximo UMA rodando, entre instâncias (duas execuções do mesmo assunto nunca se sobrepõem); responde em ordem.
// Payload só com ids (`organizationId`, `spaceId`: a convenção de `CloudSpaceJobs`, desligar o espaço cancela o que
// espera). Chamadas dentro de um unit of work entram na transação dele (o sinal do `conversations` roda na transação
// que deixou a mensagem pendente: a tarefa só existe se ela confirmar).
@Injectable()
export class CloudResponderQueue {
  constructor(private readonly jobs: JobQueue) {}

  /**
   * A pending message in a conversation with the reserve: a person's new message, or one that went back to the queue
   * (`requeued`: a new executor Hub gets its own window), waits `CLOUD_FALLBACK_AFTER_MS` for the Hub (a job already
   * waiting keeps the earlier start); "responder pela nuvem", no executor Hub, or another reason (reserve switched on,
   * key rotated, cloud answer switched on) looks now (moving a waiting job to now: it re-reads everything and an early
   * look only reschedules for when the message is due, counted from `sentAt`/`requeuedAt`).
   */
  async onPending(ctx: CloudReservePendingContext): Promise<void> {
    const payload: AnswerConversationPayload = {
      organizationId: ctx.organizationId,
      spaceId: ctx.spaceId,
      conversationId: ctx.conversationId,
    };
    if (
      (ctx.reason === 'sent' || ctx.reason === 'requeued') &&
      !ctx.immediate
    ) {
      await this.later(payload, Math.ceil(CLOUD_FALLBACK_AFTER_MS / 1000));
      return;
    }
    await this.now(payload);
  }

  /** Starts now (replaces the start time of a waiting job of the conversation). */
  async now(payload: AnswerConversationPayload): Promise<void> {
    await this.jobs.send(ANSWER_CONVERSATION_QUEUE, payload, {
      singletonKey: singletonKey(payload.conversationId),
      startAfterSeconds: 0,
    });
  }

  /**
   * Starts in `seconds`. The queue is keyed (`oneJobPerKey`): a job of the conversation already waiting is not doubled,
   * it moves to the earlier of the two starts.
   */
  async later(
    payload: AnswerConversationPayload,
    seconds: number,
  ): Promise<void> {
    await this.jobs.sendMany(ANSWER_CONVERSATION_QUEUE, [
      {
        payload,
        singletonKey: singletonKey(payload.conversationId),
        startAfterSeconds: Math.max(1, seconds),
      },
    ]);
  }
}
