import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobQueue } from '../../shared/application/job-queue.js';
import { ConversationUsageReconcileStore } from './ports/conversation-usage-reconcile-store.js';

export const CONVERSATION_USAGE_RECONCILE_QUEUE =
  'conversations.usage-reconcile';
/** Every day at 03:00 UTC: after the retention (02:00 UTC), before `storage.reconcile` (04:00 UTC). */
export const CONVERSATION_USAGE_RECONCILE_CRON = '0 3 * * *';

export type ConversationUsageReconcileResult = {
  spaces: number;
  /** Counters that had drifted and were set to the recount. */
  corrected: number;
  /** Spaces whose recount failed (logged; the next run retries). */
  failed: number;
};

// Varredura do contador `conversation_space_usage` (o uso dos assuntos no espaço, mantido só pelos triggers): uma vez
// por dia recontar cada espaço (corpos guardados + cabeçalhos; corpos guardados com lápide = lixeira) e corrigir uma
// deriva. Os triggers não deveriam derivar: corrigir é a rede de segurança, e cada correção vai ao log (só ids e
// números) para alguém investigar. Contexto de confiança `app.conversation_usage_reconcile` (um espaço por transação;
// veja `ConversationUsageReconcileStore`). Idempotente.
@Injectable()
export class ConversationUsageReconcile implements OnModuleInit {
  private readonly logger = new Logger(ConversationUsageReconcile.name);

  constructor(
    private readonly store: ConversationUsageReconcileStore,
    private readonly jobs: JobQueue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.work(CONVERSATION_USAGE_RECONCILE_QUEUE, async () => {
      const result = await this.run();
      this.logger.log(
        `conversation usage reconcile: ${JSON.stringify(result)}`,
      );
    });
    await this.jobs.schedule(
      CONVERSATION_USAGE_RECONCILE_QUEUE,
      CONVERSATION_USAGE_RECONCILE_CRON,
    );
  }

  async run(): Promise<ConversationUsageReconcileResult> {
    const result: ConversationUsageReconcileResult = {
      spaces: 0,
      corrected: 0,
      failed: 0,
    };
    for (const counter of await this.store.counters()) {
      try {
        const drift = await this.store.recount(counter);
        result.spaces += 1;
        if (drift.bodyBytesDrift !== 0 || drift.trashBytesDrift !== 0) {
          result.corrected += 1;
          this.logger.warn(
            { ...counter, ...drift },
            'conversation usage counter drifted; set to the recount',
          );
        }
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          { err: error, ...counter },
          'conversation usage recount failed for one space; the next run retries it',
        );
      }
    }
    return result;
  }
}
