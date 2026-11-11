import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CloudReservePendingHooks } from '../../../shared/application/cloud-reserve-pending-hooks.js';
import { JobQueue } from '../../../shared/application/job-queue.js';
import { CloudSpaceJobs } from '../cloud-space-jobs.js';
import { AnswerConversationJob } from './answer-conversation.job.js';
import {
  ANSWER_CONVERSATION_QUEUE,
  CloudResponderQueue,
  type AnswerConversationPayload,
} from './cloud-responder-queue.js';

export const CLOUD_RESERVE_PENDING_HOOK = 'cloud.responder';

// Liga a resposta pela nuvem: o sinal do `conversations` ("mensagem pendente num assunto com a reserva",
// `CloudReservePendingHooks`, dentro da transação que a deixou pendente) agenda a tarefa do assunto (só agenda: nenhuma
// chamada externa nem trava); a fila entra em `CloudSpaceJobs` (desligar o espaço cancela o que espera); o handler
// roda só com JOB_WORKERS_ENABLED.
@Injectable()
export class CloudResponderWorkers implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly jobs: JobQueue,
    private readonly spaceJobs: CloudSpaceJobs,
    private readonly hooks: CloudReservePendingHooks,
    private readonly queue: CloudResponderQueue,
    private readonly job: AnswerConversationJob,
  ) {}

  async onModuleInit(): Promise<void> {
    this.spaceJobs.register(ANSWER_CONVERSATION_QUEUE);
    this.hooks.register({
      name: CLOUD_RESERVE_PENDING_HOOK,
      onPending: (ctx) => this.queue.onPending(ctx),
    });
    await this.jobs.work<AnswerConversationPayload>(
      ANSWER_CONVERSATION_QUEUE,
      (payload) => this.job.run(payload),
      // One waiting + at most ONE running job per conversation, across instances: two runs of a conversation never
      // overlap (no answer paid twice, no notice racing an answer).
      { oneJobPerKey: true },
    );
  }

  onModuleDestroy(): void {
    this.hooks.unregister(CLOUD_RESERVE_PENDING_HOOK);
  }
}
