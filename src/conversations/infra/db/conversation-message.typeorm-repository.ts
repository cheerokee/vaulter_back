import { Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import {
  currentManager,
  runWithContext,
} from '../../../shared/infra/db/unit-of-work.js';
import type { ConversationScope } from '../../domain/conversation-actor.js';
import { conversationNotFound } from '../../domain/conversation-errors.js';
import {
  ConversationMessageRepository,
  type AckedBy,
  type ExpiredAgentLease,
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
          ackedLeaseUntil: message.ackedLeaseUntil,
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
    // The cloud answers one message at a time, after its own ack: its answer is a cloud message after the ACK (an
    // answer to an earlier message, sent after this one arrived, never counts). A Hub may ack in batches: after `sent_at`.
    const [acked, authored] =
      by.kind === 'hub'
        ? [
            'msg.acked_by_hub_id = $3',
            // An agent's ack (under a lease) is answered only by its own answer (`answers_message_id`).
            `reply.author_hub_id = $3 AND CASE WHEN msg.acked_lease_until IS NOT NULL
               THEN reply.answers_message_id = msg.id ELSE reply.sent_at > msg.sent_at END`,
          ]
        : [
            'msg.acked_by_cloud',
            'reply.author_cloud AND reply.sent_at > msg.acked_at',
          ];
    const params =
      by.kind === 'hub'
        ? [scope.organizationId, conversationId, by.hubId]
        : [scope.organizationId, conversationId];
    const raw: unknown = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `UPDATE conversation_messages msg
            SET pending = true, acked_at = NULL, acked_by_hub_id = NULL, acked_by_cloud = false,
                acked_lease_until = NULL, requeued_at = clock_timestamp(),
                requeued_lease_expired = false, updated_at = now()
          WHERE msg.organization_id = $1 AND msg.conversation_id = $2 AND ${acked}
            AND msg.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM conversation_messages reply
               WHERE reply.organization_id = msg.organization_id AND reply.conversation_id = msg.conversation_id
                 AND ${authored})
        RETURNING msg.id`,
        params,
      ),
    );
    const ids = updatedRows<{ id: string }>(raw).map((r) => r.id);
    // The hub stops being the executor: the agent leases it still holds here (answered messages) go with it, so a
    // lease always belongs to the current executor (the lease sweep reads the conversation in that hub's context).
    if (by.kind === 'hub') {
      await inScope(this.dataSource, scope, (m) =>
        m.query(
          `UPDATE conversation_messages SET acked_lease_until = NULL, updated_at = now()
            WHERE organization_id = $1 AND conversation_id = $2 AND acked_by_hub_id = $3
              AND acked_lease_until IS NOT NULL`,
          params,
        ),
      );
    }
    return ids;
  }

  // Contexto `app.agent_lease_sweep` (migration ConversationAgentAckLease): só as linhas com prazo, de toda organização.
  async listExpiredAgentLeases(
    limit: number,
    after: ExpiredAgentLease | null = null,
  ): Promise<ExpiredAgentLease[]> {
    const rows: {
      organization_id: string;
      conversation_id: string;
      acked_by_hub_id: string;
    }[] = await runWithContext(
      this.dataSource,
      {
        organizationId: '',
        userId: '',
        hubId: '',
        cloudExecutorSpaceId: '',
        agentLeaseSweep: 'on',
      },
      (m) =>
        m.query(
          `SELECT organization_id, conversation_id, acked_by_hub_id
             FROM conversation_messages
            WHERE acked_lease_until IS NOT NULL AND NOT pending AND acked_lease_until <= clock_timestamp()
              AND ($2::uuid IS NULL OR (conversation_id, acked_by_hub_id) > ($2::uuid, $3::uuid))
            GROUP BY organization_id, conversation_id, acked_by_hub_id
            ORDER BY conversation_id, acked_by_hub_id
            LIMIT $1`,
          [limit, after?.conversationId ?? null, after?.hubId ?? null],
        ),
    );
    return rows.map((r) => ({
      organizationId: r.organization_id,
      conversationId: r.conversation_id,
      hubId: r.acked_by_hub_id,
    }));
  }

  // "Respondida pelo agente" = mensagem dele com `answers_message_id` = ela (spec pc-agent §5.3, fix round 1). Um
  // instante só (`$3`, lido uma vez): o segundo UPDATE limpa exatamente os vencidos que o primeiro não devolveu à fila.
  async requeueExpiredAgentLeases(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<{ requeued: string[]; cleared: number }> {
    return inScope(this.dataSource, scope, async (m) => {
      const [{ now }] = (await m.query(`SELECT clock_timestamp() AS now`)) as {
        now: Date;
      }[];
      const params = [scope.organizationId, conversationId, now];
      const raw: unknown = await m.query(
        `UPDATE conversation_messages msg
            SET pending = true, acked_at = NULL, acked_by_hub_id = NULL, acked_by_cloud = false,
                acked_lease_until = NULL, requeued_at = clock_timestamp(),
                requeued_lease_expired = true, updated_at = now()
          WHERE msg.organization_id = $1 AND msg.conversation_id = $2
            AND msg.acked_lease_until IS NOT NULL AND msg.acked_lease_until <= $3
            AND msg.author_user_id IS NOT NULL AND msg.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM conversation_messages reply
               WHERE reply.organization_id = msg.organization_id AND reply.conversation_id = msg.conversation_id
                 AND reply.answers_message_id = msg.id)
        RETURNING msg.id`,
        params,
      );
      // What is left expired at the same instant was answered (or tombstoned): only the lease goes, the ack stays.
      const left: unknown = await m.query(
        `UPDATE conversation_messages SET acked_lease_until = NULL, updated_at = now()
          WHERE organization_id = $1 AND conversation_id = $2
            AND acked_lease_until IS NOT NULL AND acked_lease_until <= $3
        RETURNING id`,
        params,
      );
      return {
        requeued: updatedRows<{ id: string }>(raw).map((r) => r.id),
        cleared: updatedRows<{ id: string }>(left).length,
      };
    });
  }

  async answeredBy(
    scope: ConversationScope,
    conversationId: string,
    messageId: string,
  ): Promise<boolean> {
    const rows: unknown[] = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `SELECT 1 FROM conversation_messages
          WHERE organization_id = $1 AND conversation_id = $2 AND answers_message_id = $3
          LIMIT 1`,
        [scope.organizationId, conversationId, messageId],
      ),
    );
    return rows.length > 0;
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
    limit: number,
  ): Promise<{ messages: number; bytes: number; remaining: number }> {
    return inScope(this.dataSource, scope, async (m) => {
      const raw: unknown = await m.query(
        `UPDATE conversation_messages SET encrypted_body = NULL, updated_at = now()
          WHERE organization_id = $1 AND id IN (
                SELECT id FROM conversation_messages
                 WHERE organization_id = $1 AND conversation_id = $2
                   AND deleted_at IS NOT NULL AND encrypted_body IS NOT NULL
                 ORDER BY id
                 LIMIT $3)
        RETURNING body_bytes`,
        [scope.organizationId, conversationId, limit],
      );
      const rows = updatedRows<{ body_bytes: number }>(raw);
      const left: { n: string }[] = await m.query(
        `SELECT count(*)::text AS n FROM conversation_messages
          WHERE organization_id = $1 AND conversation_id = $2
            AND deleted_at IS NOT NULL AND encrypted_body IS NOT NULL`,
        [scope.organizationId, conversationId],
      );
      return {
        messages: rows.length,
        bytes: rows.reduce((sum, r) => sum + Number(r.body_bytes), 0),
        remaining: Number(left[0]?.n ?? 0),
      };
    });
  }
}
