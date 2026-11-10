import { Logger } from '@nestjs/common';
import type { ObjectStore } from '../../storage/application/ports/object-store.js';
import { CONVERSATION_RETENTION_DAYS } from '../domain/conversation-limits.js';
import { removePurgedAttachments } from './attachment-bucket.js';
import type { ConversationRetentionStore } from './ports/conversation-retention-store.js';

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
// sincronização) e tira os anexos do bucket. Roda pelo CLI `npm run conversations:retention`, com o login DONO (veja
// `ConversationRetentionStore`), 1x por dia (CLAUDE.md, Pendências). Um assunto por transação; os anexos seguem a regra
// do diário do storage: índice `purged` + marca renovada no COMMIT, e SÓ DEPOIS o `DeleteObjects` em lote (o que não
// sair fica marcado para a varredura `storage:reconcile`, que o apaga: `purged` não referencia versão). Uma falha num
// assunto é registrada e a rotina segue (a próxima passada tenta de novo; tudo é idempotente).
// Fica fora do contêiner de DI de propósito: a API nunca segura a conexão do dono.
export class ConversationRetention {
  private readonly logger = new Logger(ConversationRetention.name);

  constructor(
    private readonly store: ConversationRetentionStore,
    private readonly objects: ObjectStore,
    private readonly retentionDays = CONVERSATION_RETENTION_DAYS,
  ) {}

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
        const purged = await this.store.purge(candidate, this.retentionDays);
        result.conversations += 1;
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
