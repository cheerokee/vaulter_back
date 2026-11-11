import { Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { ConversationScope } from '../../domain/conversation-actor.js';
import { conversationNotFound } from '../../domain/conversation-errors.js';
import {
  ConversationMessageRepository,
  type AckedBy,
} from '../../domain/conversation-message.repository.js';
import type { ConversationMessage } from '../../domain/conversation-message.js';
import { ConversationMessageTypeormEntity } from './conversation-message.entity.js';
import { inScope, updatedRows } from './conversation-scope.js';
import { messageToDomain, messageToInsert } from './conversation.mapper.js';

@Injectable()
export class ConversationMessageTypeormRepository extends ConversationMessageRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // Reenvio do mesmo id não duplica: ON CONFLICT (id) DO NOTHING.
  async insertIfAbsent(
    scope: ConversationScope,
    message: ConversationMessage,
  ): Promise<boolean> {
    const result = await inScope(this.dataSource, scope, (m) =>
      m
        .getRepository(ConversationMessageTypeormEntity)
        .createQueryBuilder()
        .insert()
        .values(messageToInsert(message))
        .orIgnore()
        .returning('id')
        .execute(),
    );
    return (result.raw as unknown[]).length > 0;
  }

  async findById(
    scope: ConversationScope,
    id: string,
    options: { withDeleted?: boolean } = {},
  ): Promise<ConversationMessage | null> {
    const row = await inScope(this.dataSource, scope, (m) =>
      m.getRepository(ConversationMessageTypeormEntity).findOne({
        where: { id, organizationId: scope.organizationId },
        withDeleted: options.withDeleted ?? false,
      }),
    );
    return row ? messageToDomain(row) : null;
  }

  async save(
    scope: ConversationScope,
    message: ConversationMessage,
  ): Promise<void> {
    const result = await inScope(this.dataSource, scope, (m) =>
      m.getRepository(ConversationMessageTypeormEntity).update(
        { id: message.id, organizationId: scope.organizationId },
        {
          pending: message.pending,
          ackedAt: message.ackedAt,
          ackedByHubId: message.ackedByHubId,
          ackedByCloud: message.ackedByCloud,
          encryptedBody: message.encryptedBody,
          deletedAt: message.deletedAt,
        },
      ),
    );
    if (!result.affected) throw conversationNotFound();
  }

  async databaseNow(): Promise<Date> {
    const rows: { now: Date }[] = await currentManager(this.dataSource).query(
      `SELECT clock_timestamp() AS now`,
    );
    return rows[0]!.now;
  }

  // `by`: o Hub (acked_by_hub_id / author_hub_id = $3) ou a nuvem (acked_by_cloud / author_cloud; $3 nulo).
  async requeueAckedBy(
    scope: ConversationScope,
    conversationId: string,
    by: AckedBy,
  ): Promise<string[]> {
    const [acked, authored] =
      by.kind === 'hub'
        ? ['msg.acked_by_hub_id = $3', 'reply.author_hub_id = $3']
        : ['msg.acked_by_cloud', 'reply.author_cloud'];
    const params =
      by.kind === 'hub'
        ? [scope.organizationId, conversationId, by.hubId]
        : [scope.organizationId, conversationId];
    const raw: unknown = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `UPDATE conversation_messages msg
            SET pending = true, acked_at = NULL, acked_by_hub_id = NULL, acked_by_cloud = false, updated_at = now()
          WHERE msg.organization_id = $1 AND msg.conversation_id = $2 AND ${acked}
            AND msg.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM conversation_messages reply
               WHERE reply.organization_id = msg.organization_id AND reply.conversation_id = msg.conversation_id
                 AND ${authored} AND reply.sent_at > msg.sent_at)
        RETURNING msg.id`,
        params,
      ),
    );
    return updatedRows<{ id: string }>(raw).map((r) => r.id);
  }

  // Mesma regra do `requeueAckedBy` (mensagem do autor depois da confirmada, com ou sem lápide).
  async answeredAfter(
    scope: ConversationScope,
    conversationId: string,
    by: AckedBy,
    after: Date,
  ): Promise<boolean> {
    const [authored, params] =
      by.kind === 'hub'
        ? [
            'author_hub_id = $4',
            [scope.organizationId, conversationId, after, by.hubId],
          ]
        : ['author_cloud', [scope.organizationId, conversationId, after]];
    const rows: unknown[] = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `SELECT 1 FROM conversation_messages
          WHERE organization_id = $1 AND conversation_id = $2 AND ${authored} AND sent_at > $3
          LIMIT 1`,
        params,
      ),
    );
    return rows.length > 0;
  }

  async listRecent(
    scope: ConversationScope,
    conversationId: string,
    limit: number,
  ): Promise<ConversationMessage[]> {
    const rows = await inScope(this.dataSource, scope, (m) =>
      m.getRepository(ConversationMessageTypeormEntity).find({
        where: {
          organizationId: scope.organizationId,
          conversationId,
          deletedAt: IsNull(),
        },
        order: { sentAt: 'DESC', id: 'DESC' },
        take: limit,
      }),
    );
    return rows.map(messageToDomain).reverse();
  }

  async listPending(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<ConversationMessage[]> {
    const rows = await inScope(this.dataSource, scope, (m) =>
      m.getRepository(ConversationMessageTypeormEntity).find({
        where: {
          organizationId: scope.organizationId,
          conversationId,
          pending: true,
          deletedAt: IsNull(),
        },
        order: { sentAt: 'ASC', id: 'ASC' },
      }),
    );
    return rows.map(messageToDomain);
  }

  async purgeTrash(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<{ messages: number; bytes: number }> {
    const raw: unknown = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `UPDATE conversation_messages SET encrypted_body = NULL, updated_at = now()
          WHERE organization_id = $1 AND conversation_id = $2
            AND deleted_at IS NOT NULL AND encrypted_body IS NOT NULL
        RETURNING body_bytes`,
        [scope.organizationId, conversationId],
      ),
    );
    const rows = updatedRows<{ body_bytes: number }>(raw);
    return {
      messages: rows.length,
      bytes: rows.reduce((sum, r) => sum + Number(r.body_bytes), 0),
    };
  }
}
