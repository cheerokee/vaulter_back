import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runWithContext } from '../../../shared/infra/db/unit-of-work.js';
import { CONVERSATION_RETENTION_BATCH_ROWS } from '../../domain/conversation-limits.js';
import {
  ConversationRetentionStore,
  type RetentionCandidate,
  type RetentionPurge,
} from '../../application/ports/conversation-retention-store.js';
import { purgedFromRow } from './conversation-attachment.typeorm-repository.js';
import { updatedRows } from './conversation-scope.js';

const CUTOFF = `now() - make_interval(days => $3)`;

// A retenção em SQL com o login de RUNTIME, pelo contexto de confiança `app.conversation_retention` (migration
// MaintenanceTrustedContexts; decisão B7): 'scan' só enxerga o que passou da janela, em todas as organizações; o id de
// UM assunto abre esse assunto, o conteúdo vencido dele e as linhas de uso do espaço dele (os triggers de uso precisam
// ver o assunto mesmo depois de o último participante sair), e as policies só aceitam zerar/`purged`. Sem
// `app.organization_id`: nada mais da organização fica visível. A janela das policies é fixa (30 dias,
// `CONVERSATION_RETENTION_DAYS`): pedir menos não zera nada que a policy esconde.
// Só zera o que passou da janela (relógio do banco); nunca apaga linha (o runtime não tem DELETE, e a lápide fica para a
// sincronização).
@Injectable()
export class ConversationRetentionSqlStore extends ConversationRetentionStore {
  /** Rows per batch (the e2e lowers it to cross batches). */
  batchRows = CONVERSATION_RETENTION_BATCH_ROWS;

  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async candidates(retentionDays: number): Promise<RetentionCandidate[]> {
    const rows: { organization_id: string; id: string }[] =
      await runWithContext(
        this.dataSource,
        { conversationRetention: 'scan' },
        (m) =>
          m.query(
            // Three driving sets, each on its partial index (migration MaintenanceIndexes): conversations tombstoned past
            // the window that still keep something, and messages / attachments tombstoned past it. UNION dedupes.
            `WITH due AS (
           SELECT c.organization_id, c.id FROM conversations c
            WHERE c.deleted_at IS NOT NULL AND c.deleted_at < now() - make_interval(days => $1)
              AND (c.encrypted_header IS NOT NULL
                   OR EXISTS (SELECT 1 FROM conversation_messages m
                               WHERE m.conversation_id = c.id AND m.organization_id = c.organization_id
                                 AND m.encrypted_body IS NOT NULL)
                   OR EXISTS (SELECT 1 FROM conversation_attachments a
                               WHERE a.conversation_id = c.id AND a.organization_id = c.organization_id
                                 AND a.status = 'committed'))
           UNION
           SELECT m.organization_id, m.conversation_id FROM conversation_messages m
            WHERE m.deleted_at IS NOT NULL AND m.encrypted_body IS NOT NULL
              AND m.deleted_at < now() - make_interval(days => $1)
           UNION
           SELECT a.organization_id, a.conversation_id FROM conversation_attachments a
            WHERE a.deleted_at IS NOT NULL AND a.status = 'committed'
              AND a.deleted_at < now() - make_interval(days => $1)
         )
         SELECT DISTINCT organization_id, id FROM due ORDER BY organization_id, id`,
            [retentionDays],
          ),
      );
    return rows.map((r) => ({
      organizationId: r.organization_id,
      conversationId: r.id,
    }));
  }

  purge(
    { organizationId, conversationId }: RetentionCandidate,
    retentionDays: number,
  ): Promise<RetentionPurge> {
    const params = [conversationId, organizationId, retentionDays];
    return runWithContext(
      this.dataSource,
      { conversationRetention: conversationId },
      async (m) => {
        const locked: unknown[] = await m.query(
          `SELECT id FROM conversations WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          params.slice(0, 2),
        );
        if (locked.length === 0) {
          return {
            messages: 0,
            messageBytes: 0,
            attachments: [],
            headerPurged: false,
            more: false,
          };
        }
        // Mensagem de assunto com lápide recebe a lápide do assunto (CHECK: corpo nulo só com lápide).
        const messages = updatedRows<{ body_bytes: number }>(
          await m.query(
            `WITH batch AS (
             SELECT msg.id FROM conversation_messages msg
               JOIN conversations c ON c.id = msg.conversation_id AND c.organization_id = msg.organization_id
              WHERE msg.conversation_id = $1 AND msg.organization_id = $2 AND msg.encrypted_body IS NOT NULL
                AND (msg.deleted_at < ${CUTOFF} OR c.deleted_at < ${CUTOFF})
              ORDER BY msg.id
              LIMIT $4
                FOR UPDATE OF msg
           )
           UPDATE conversation_messages msg
              SET encrypted_body = NULL, deleted_at = COALESCE(msg.deleted_at, c.deleted_at), updated_at = now()
             FROM batch, conversations c
            WHERE msg.id = batch.id AND c.id = msg.conversation_id AND c.organization_id = msg.organization_id
          RETURNING msg.body_bytes`,
            [...params, this.batchRows],
          ),
        );
        const room = this.batchRows - messages.length;
        const attachments =
          room === 0
            ? []
            : updatedRows<Parameters<typeof purgedFromRow>[0]>(
                await m.query(
                  `WITH batch AS (
             SELECT a.id FROM conversation_attachments a
               JOIN conversations c ON c.id = a.conversation_id AND c.organization_id = a.organization_id
              WHERE a.conversation_id = $1 AND a.organization_id = $2 AND a.status = 'committed'
                AND (a.deleted_at < ${CUTOFF} OR c.deleted_at < ${CUTOFF})
              ORDER BY a.id
              LIMIT $4
                FOR UPDATE OF a
           )
           UPDATE conversation_attachments a
              SET status = 'purged', s3_write_started_at = now(),
                  deleted_at = COALESCE(a.deleted_at, c.deleted_at), updated_at = now()
             FROM batch, conversations c
            WHERE a.id = batch.id AND c.id = a.conversation_id AND c.organization_id = a.organization_id
          RETURNING a.organization_id, a.space_id, a.conversation_id, a.id, a.s3_version_id, a.size_bytes::text`,
                  [...params, room],
                ),
              );
        const more = room === 0 || attachments.length === room;
        // The header goes in the last batch only.
        const header = more
          ? []
          : updatedRows<{ id: string }>(
              await m.query(
                `UPDATE conversations SET encrypted_header = NULL, header_key_version = NULL, updated_at = now()
            WHERE id = $1 AND organization_id = $2 AND deleted_at < ${CUTOFF} AND encrypted_header IS NOT NULL
          RETURNING id`,
                params,
              ),
            );
        return {
          messages: messages.length,
          messageBytes: messages.reduce(
            (sum, r) => sum + Number(r.body_bytes),
            0,
          ),
          attachments: attachments.map(purgedFromRow),
          headerPurged: header.length > 0,
          more,
        };
      },
    );
  }
}
