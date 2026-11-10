import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { validate } from 'uuid';
import { byteCount } from '../../../shared/infra/db/byte-count.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import {
  ConversationSpaceUsageRepository,
  type ConversationSpaceUsageTotals,
} from '../../domain/conversation-space-usage.repository.js';

// Lê o contador do trigger `trg_conversation_messages_space_usage` (migration ConversationSpaceUsage) e a projeção dos
// anexos do trigger `trg_conversation_attachments_space_usage` (migration ConversationAttachmentStorage) no escopo da
// organização (dentro de um unit of work, entra na transação de quem chama). Reserva conta enquanto
// `reserved_until > now()` (relógio da transação, como o backup). Espaço sem nada: 0.
@Injectable()
export class ConversationSpaceUsageTypeormRepository extends ConversationSpaceUsageRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async totals(
    organizationId: string,
    spaceId: string,
  ): Promise<ConversationSpaceUsageTotals> {
    if (!validate(organizationId) || !validate(spaceId)) {
      return {
        bodyBytes: 0,
        trashBytes: 0,
        attachmentBytes: 0,
        attachmentTrashBytes: 0,
      };
    }
    const rows: {
      body_bytes: string;
      trash_bytes: string;
      attachment_bytes: string;
      attachment_trash_bytes: string;
    }[] = await runInOrganizationScope(this.dataSource, organizationId, (m) =>
      m.query(
        `SELECT
           COALESCE((SELECT body_bytes FROM conversation_space_usage
                      WHERE organization_id = $1 AND space_id = $2), 0)::text AS body_bytes,
           COALESCE((SELECT trash_bytes FROM conversation_space_usage
                      WHERE organization_id = $1 AND space_id = $2), 0)::text AS trash_bytes,
           COALESCE(SUM(a.size_bytes) FILTER (WHERE a.stored OR a.reserved_until > now()), 0)::text
             AS attachment_bytes,
           COALESCE(SUM(a.size_bytes) FILTER (WHERE a.trash), 0)::text AS attachment_trash_bytes
           FROM conversation_attachment_usage a
          WHERE a.organization_id = $1 AND a.space_id = $2`,
        [organizationId, spaceId],
      ),
    );
    const r = rows[0];
    return {
      bodyBytes: byteCount(r?.body_bytes ?? '0'),
      trashBytes: byteCount(r?.trash_bytes ?? '0'),
      attachmentBytes: byteCount(r?.attachment_bytes ?? '0'),
      attachmentTrashBytes: byteCount(r?.attachment_trash_bytes ?? '0'),
    };
  }
}
