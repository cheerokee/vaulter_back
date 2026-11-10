import type { DataSource } from 'typeorm';
import {
  ConversationRetentionStore,
  type RetentionCandidate,
  type RetentionPurge,
} from '../../application/ports/conversation-retention-store.js';
import { purgedFromRow } from './conversation-attachment.typeorm-repository.js';
import { updatedRows } from './conversation-scope.js';

const CUTOFF = `now() - make_interval(days => $3)`;

// A retenção em SQL com o login DONO (`typeOrmOptions('migration')`, o CLI `conversations:retention` abre o
// DataSource): sem contexto de RLS. Exceção documentada ao "toda escrita pelo login de runtime": um assunto com lápide
// cujo último participante saiu não é visível a nenhum contexto de runtime (participante vivo ou executor), e os
// triggers de uso (`conversation_messages_space_usage`) precisam ver o assunto. O dono só ignora o RLS sendo
// superusuário ou com BYPASSRLS (CLAUDE.md, Pendências: papel de manutenção no Postgres gerenciado).
// Só zera o que passou da janela (relógio do banco); nunca apaga linha (o runtime não tem DELETE, e a lápide fica para a
// sincronização).
export class ConversationRetentionSqlStore extends ConversationRetentionStore {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async bypassesRowSecurity(): Promise<boolean> {
    const rows: { ok: boolean }[] = await this.dataSource.query(
      `SELECT rolsuper OR rolbypassrls AS ok FROM pg_roles WHERE rolname = current_user`,
    );
    return rows[0]?.ok === true;
  }

  async candidates(retentionDays: number): Promise<RetentionCandidate[]> {
    const rows: { organization_id: string; id: string }[] =
      await this.dataSource.query(
        `SELECT c.organization_id, c.id FROM conversations c
          WHERE (c.deleted_at < now() - make_interval(days => $1) AND (
                   c.encrypted_header IS NOT NULL
                   OR EXISTS (SELECT 1 FROM conversation_messages m
                               WHERE m.conversation_id = c.id AND m.organization_id = c.organization_id
                                 AND m.encrypted_body IS NOT NULL)
                   OR EXISTS (SELECT 1 FROM conversation_attachments a
                               WHERE a.conversation_id = c.id AND a.organization_id = c.organization_id
                                 AND a.status = 'committed')))
             OR EXISTS (SELECT 1 FROM conversation_messages m
                         WHERE m.conversation_id = c.id AND m.organization_id = c.organization_id
                           AND m.encrypted_body IS NOT NULL
                           AND m.deleted_at < now() - make_interval(days => $1))
             OR EXISTS (SELECT 1 FROM conversation_attachments a
                         WHERE a.conversation_id = c.id AND a.organization_id = c.organization_id
                           AND a.status = 'committed'
                           AND a.deleted_at < now() - make_interval(days => $1))
          ORDER BY c.space_id, c.id`,
        [retentionDays],
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
    return this.dataSource.transaction(async (m) => {
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
        };
      }
      // Mensagem de assunto com lápide recebe a lápide do assunto (CHECK: corpo nulo só com lápide).
      const messages = updatedRows<{ body_bytes: number }>(
        await m.query(
          `UPDATE conversation_messages msg
              SET encrypted_body = NULL, deleted_at = COALESCE(msg.deleted_at, c.deleted_at), updated_at = now()
             FROM conversations c
            WHERE c.id = msg.conversation_id AND c.organization_id = msg.organization_id
              AND msg.conversation_id = $1 AND msg.organization_id = $2 AND msg.encrypted_body IS NOT NULL
              AND (msg.deleted_at < ${CUTOFF} OR c.deleted_at < ${CUTOFF})
          RETURNING msg.body_bytes`,
          params,
        ),
      );
      const attachments = updatedRows<Parameters<typeof purgedFromRow>[0]>(
        await m.query(
          `WITH batch AS (
             SELECT a.id FROM conversation_attachments a
               JOIN conversations c ON c.id = a.conversation_id AND c.organization_id = a.organization_id
              WHERE a.conversation_id = $1 AND a.organization_id = $2 AND a.status = 'committed'
                AND (a.deleted_at < ${CUTOFF} OR c.deleted_at < ${CUTOFF})
              ORDER BY a.id
                FOR UPDATE OF a
           )
           UPDATE conversation_attachments a
              SET status = 'purged', s3_write_started_at = now(),
                  deleted_at = COALESCE(a.deleted_at, c.deleted_at), updated_at = now()
             FROM batch, conversations c
            WHERE a.id = batch.id AND c.id = a.conversation_id AND c.organization_id = a.organization_id
          RETURNING a.organization_id, a.space_id, a.conversation_id, a.id, a.s3_version_id, a.size_bytes::text`,
          params,
        ),
      );
      const header = updatedRows<{ id: string }>(
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
      };
    });
  }
}
