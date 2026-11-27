import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobQueue } from '../../shared/application/job-queue.js';
import { ObjectStore } from '../../storage/application/ports/object-store.js';
import { CONVERSATION_RETENTION_DAYS } from '../domain/conversation-limits.js';
import { removePurgedAttachments } from './attachment-bucket.js';
import { ConversationRetentionStore } from './ports/conversation-retention-store.js';

export const CONVERSATION_RETENTION_QUEUE = 'conversations.retention';
/**
 * Every day at 02:00 UTC: before `storage.reconcile` (04:00 UTC), which only sweeps journal marks older than 60 min and
 * deletes from the bucket what this run's `DeleteObjects` left behind.
 */
export const CONVERSATION_RETENTION_CRON = '0 2 * * *';

export type ConversationRetentionResult = {
  conversations: number;
  messages: number;
  messageBytes: number;
  attachments: number;
  attachmentBytes: number;
  /** S3 versions deleted now (the rest keep their journal mark for `storage:reconcile`). */
  removedVersions: number;
  headers: number;
  /** Conversations whose purge failed (logged; the next run retries them). */
  failed: number;
};

// Retenção dos assuntos (spec §4.4.1): mensagem, anexo ou assunto com lápide guarda o conteúdo cifrado por 30 dias
// (relógio do banco); depois esta rotina zera os corpos e o cabeçalho (UPDATE: a linha e a lápide ficam para a
// sincronização) e tira os anexos do bucket. Tarefa agendada do pg-boss (`conversations.retention`, 02:00 UTC, só em
// processo com `JOB_WORKERS_ENABLED`) e o CLI `npm run conversations:retention` sob demanda, ambos com o login de
// runtime no contexto de confiança `app.conversation_retention` (veja `ConversationRetentionStore`). Um lote por
// transação (até `CONVERSATION_RETENTION_BATCH_ROWS` linhas de um assunto; o assunto se repete enquanto o lote vier
// cheio: todo commit que grava nos assuntos segura a trava das versões até o fim, veja `addCommitOrderedSyncVersion`); os
// anexos seguem a regra do diário do storage: índice `purged` + marca renovada no COMMIT, e SÓ DEPOIS o `DeleteObjects`
// em lote (o que não sair fica marcado para a varredura `storage:reconcile`, que o apaga: `purged` não referencia
// versão). Uma falha num assunto é registrada e a rotina segue (a próxima passada tenta de novo; tudo é idempotente,
// inclusive uma retentativa do pg-boss ou o CLI rodando junto). O registro leva só contagens.
@Injectable()
export class ConversationRetention implements OnModuleInit {
  private readonly logger = new Logger(ConversationRetention.name);

  private readonly retentionDays = CONVERSATION_RETENTION_DAYS;

  constructor(
    private readonly store: ConversationRetentionStore,
    private readonly objects: ObjectStore,
    private readonly jobs: JobQueue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.work(CONVERSATION_RETENTION_QUEUE, async () => {
      const result = await this.execute();
      this.logger.log(`conversation retention: ${JSON.stringify(result)}`);
      // Some conversation failed (logged): the job fails too, so pg-boss retries (idempotent) and the failure shows.
      if (result.failed > 0) {
        throw new Error(
          `conversation retention: ${result.failed} conversation(s) failed`,
        );
      }
    });
    await this.jobs.schedule(
      CONVERSATION_RETENTION_QUEUE,
      CONVERSATION_RETENTION_CRON,
    );
  }

  async execute(): Promise<ConversationRetentionResult> {
    const result: ConversationRetentionResult = {
      conversations: 0,
      messages: 0,
      messageBytes: 0,
      attachments: 0,
      attachmentBytes: 0,
      removedVersions: 0,
      headers: 0,
      failed: 0,
    };
    for (const candidate of await this.store.candidates(this.retentionDays)) {
      try {
        for (;;) {
          const purged = await this.store.purge(candidate, this.retentionDays);
          result.messages += purged.messages;
          result.messageBytes += purged.messageBytes;
          result.attachments += purged.attachments.length;
          result.attachmentBytes += purged.attachments.reduce(
            (sum, a) => sum + a.sizeBytes,
            0,
          );
          if (purged.headerPurged) result.headers += 1;
          result.removedVersions += await removePurgedAttachments(
            this.objects,
            purged.attachments,
            this.logger,
          );
          // A full batch that purged nothing would loop forever: stop (the next run retries).
          const progressed =
            purged.messages > 0 || purged.attachments.length > 0;
          if (!purged.more || !progressed) break;
        }
        result.conversations += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          { err: error, ...candidate },
          'conversation retention failed for one conversation; the next run retries it',
        );
      }
    }
    return result;
  }
}
