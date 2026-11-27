import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runWithContext } from '../../../shared/infra/db/unit-of-work.js';
import {
  ConversationUsageReconcileStore,
  type UsageCounter,
  type UsageRecount,
} from '../../application/ports/conversation-usage-reconcile-store.js';

// A recontagem em SQL com o login de runtime, no contexto `app.conversation_usage_reconcile` (migration
// MaintenanceTrustedContexts): sem `app.organization_id`; o espaço do contexto é o único visível, só para leitura nos
// assuntos e mensagens, e o trigger de guarda deixa gravar só o contador dele. As somas seguem os triggers
// `conversation_messages_space_usage` e `conversations_header_space_usage`.
@Injectable()
export class ConversationUsageReconcileSqlStore extends ConversationUsageReconcileStore {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async counters(): Promise<UsageCounter[]> {
    const rows: { organization_id: string; space_id: string }[] =
      await runWithContext(
        this.dataSource,
        { conversationUsageReconcile: 'scan' },
        (m) =>
          m.query(
            `SELECT organization_id, space_id FROM conversation_space_usage ORDER BY space_id`,
          ),
      );
    return rows.map((r) => ({
      organizationId: r.organization_id,
      spaceId: r.space_id,
    }));
  }

  recount({ organizationId, spaceId }: UsageCounter): Promise<UsageRecount> {
    return runWithContext(
      this.dataSource,
      { conversationUsageReconcile: spaceId },
      async (m) => {
        const locked: unknown[] = await m.query(
          `SELECT 1 FROM conversation_space_usage WHERE space_id = $1 AND organization_id = $2 FOR UPDATE`,
          [spaceId, organizationId],
        );
        if (locked.length === 0) {
          return { bodyBytesDrift: 0, trashBytesDrift: 0 };
        }
        const [row] = (await m.query(
          `WITH expected AS (
             SELECT
               COALESCE((SELECT sum(m.body_bytes) FROM conversation_messages m
                           JOIN conversations c ON c.id = m.conversation_id AND c.organization_id = m.organization_id
                          WHERE c.space_id = $1 AND c.organization_id = $2 AND m.encrypted_body IS NOT NULL), 0)
             + COALESCE((SELECT sum((length(c.encrypted_header) * 3) / 4) FROM conversations c
                          WHERE c.space_id = $1 AND c.organization_id = $2), 0) AS body_bytes,
               COALESCE((SELECT sum(m.body_bytes) FROM conversation_messages m
                           JOIN conversations c ON c.id = m.conversation_id AND c.organization_id = m.organization_id
                          WHERE c.space_id = $1 AND c.organization_id = $2 AND m.encrypted_body IS NOT NULL
                            AND m.deleted_at IS NOT NULL), 0) AS trash_bytes
           )
           SELECT e.body_bytes::text AS expected_body, e.trash_bytes::text AS expected_trash,
                  u.body_bytes::text AS body, u.trash_bytes::text AS trash
             FROM expected e, conversation_space_usage u
            WHERE u.space_id = $1 AND u.organization_id = $2`,
          [spaceId, organizationId],
        )) as {
          expected_body: string;
          expected_trash: string;
          body: string;
          trash: string;
        }[];
        const drift = {
          bodyBytesDrift: Number(row!.expected_body) - Number(row!.body),
          trashBytesDrift: Number(row!.expected_trash) - Number(row!.trash),
        };
        if (drift.bodyBytesDrift !== 0 || drift.trashBytesDrift !== 0) {
          await m.query(
            `UPDATE conversation_space_usage SET body_bytes = $3, trash_bytes = $4, updated_at = now()
              WHERE space_id = $1 AND organization_id = $2`,
            [spaceId, organizationId, row!.expected_body, row!.expected_trash],
          );
        }
        return drift;
      },
    );
  }
}
