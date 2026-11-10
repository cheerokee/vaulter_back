import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { validate } from 'uuid';
import { byteCount } from '../../../shared/infra/db/byte-count.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import {
  ConversationSpaceUsageRepository,
  type ConversationSpaceUsageTotals,
} from '../../domain/conversation-space-usage.repository.js';

// Lê o contador do trigger `trg_conversation_messages_space_usage` (migration ConversationSpaceUsage) no escopo da
// organização (dentro de um unit of work, entra na transação de quem chama). Espaço sem mensagem: 0.
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
      return { bodyBytes: 0, trashBytes: 0 };
    }
    const rows: { body_bytes: string; trash_bytes: string }[] =
      await runInOrganizationScope(this.dataSource, organizationId, (m) =>
        m.query(
          `SELECT body_bytes::text, trash_bytes::text FROM conversation_space_usage
            WHERE organization_id = $1 AND space_id = $2`,
          [organizationId, spaceId],
        ),
      );
    return {
      bodyBytes: byteCount(rows[0]?.body_bytes ?? '0'),
      trashBytes: byteCount(rows[0]?.trash_bytes ?? '0'),
    };
  }
}
