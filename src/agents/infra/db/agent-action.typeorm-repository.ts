import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { validate } from 'uuid';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { AgentEffect } from '../../domain/agent-policy.js';
import type {
  AgentActionDecision,
  AgentActionItem,
} from '../../domain/agent-action.js';
import {
  AgentActionRepository,
  type AgentActionFilter,
  type AgentActionSlice,
  type RecordedAgentAction,
} from '../../domain/agent-action.repository.js';
import { AgentActionTypeormEntity } from './agent-action.entity.js';

const toItem = (r: AgentActionTypeormEntity): AgentActionItem => ({
  id: r.actionId,
  conversationId: r.conversationId,
  messageId: r.messageId,
  toolName: r.toolName,
  effect: r.effect as AgentEffect,
  decision: r.decision as AgentActionDecision,
  startedAt: r.startedAt,
  durationMs: r.durationMs,
  policyVersion: r.policyVersion,
});

const toRecorded = (r: AgentActionTypeormEntity): RecordedAgentAction => ({
  ...toItem(r),
  rowId: r.id,
  organizationId: r.organizationId,
  spaceId: r.spaceId,
  hubId: r.hubId,
  ownerUserId: r.ownerUserId,
  recordedAt: r.createdAt,
});

// Organização: sempre no escopo dela (RLS `org_isolation`) e filtrando por ela; dono: no contexto `app.user_id` (policy
// `owner_read`, só SELECT). Só de acréscimo: nada aqui faz UPDATE ou DELETE.
@Injectable()
export class AgentActionTypeormRepository extends AgentActionRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async findByIds(
    organizationId: string,
    hubId: string,
    actionIds: readonly string[],
  ): Promise<Map<string, AgentActionItem>> {
    if (actionIds.length === 0) return new Map();
    const rows = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m
          .getRepository(AgentActionTypeormEntity)
          .createQueryBuilder('a')
          .where('a.organization_id = :organizationId', { organizationId })
          .andWhere('a.hub_id = :hubId', { hubId })
          .andWhere('a.action_id = ANY(:ids)', { ids: [...actionIds] })
          .getMany(),
    );
    return new Map(rows.map((r) => [r.actionId, toItem(r)]));
  }

  async insertMany(input: {
    organizationId: string;
    hubId: string;
    ownerUserId: string;
    rows: readonly { item: AgentActionItem; spaceId: string }[];
  }): Promise<string[]> {
    if (input.rows.length === 0) return [];
    const col = <T>(f: (r: (typeof input.rows)[number]) => T) =>
      input.rows.map(f);
    const inserted = await runInOrganizationScope(
      this.dataSource,
      input.organizationId,
      (m) =>
        m.query(
          `INSERT INTO agent_action_logs
             (action_id, organization_id, space_id, hub_id, owner_user_id, conversation_id, message_id,
              tool_name, effect, decision, started_at, duration_ms, policy_version)
           SELECT t.action_id, $1, t.space_id, $2, $3, t.conversation_id, t.message_id,
                  t.tool_name, t.effect, t.decision, t.started_at, t.duration_ms, t.policy_version
             FROM unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[], $8::text[], $9::text[], $10::text[],
                         $11::timestamptz[], $12::int[], $13::int[])
                  AS t(action_id, space_id, conversation_id, message_id, tool_name, effect, decision, started_at,
                       duration_ms, policy_version)
           ON CONFLICT (hub_id, action_id) DO NOTHING
           RETURNING action_id`,
          [
            input.organizationId,
            input.hubId,
            input.ownerUserId,
            col((r) => r.item.id),
            col((r) => r.spaceId),
            col((r) => r.item.conversationId),
            col((r) => r.item.messageId),
            col((r) => r.item.toolName),
            col((r) => r.item.effect),
            col((r) => r.item.decision),
            col((r) => r.item.startedAt.toISOString()),
            col((r) => r.item.durationMs),
            col((r) => r.item.policyVersion),
          ],
        ) as Promise<{ action_id: string }[]>,
    );
    return inserted.map((r) => r.action_id);
  }

  async listOfOrganization(
    organizationId: string,
    filter: AgentActionFilter,
    slice: AgentActionSlice,
  ): Promise<RecordedAgentAction[]> {
    if (!validate(organizationId)) return [];
    const rows = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) => {
        const q = m
          .getRepository(AgentActionTypeormEntity)
          .createQueryBuilder('a')
          .where('a.organization_id = :organizationId', { organizationId });
        if (filter.userId) {
          q.andWhere('a.owner_user_id = :userId', { userId: filter.userId });
        }
        if (filter.hubId) {
          q.andWhere('a.hub_id = :hubId', { hubId: filter.hubId });
        }
        if (slice.after) q.andWhere('a.id < :after', { after: slice.after });
        return q
          .orderBy('a.id', 'DESC')
          .limit(slice.limit + 1)
          .getMany();
      },
    );
    return rows.map(toRecorded);
  }

  async listOfHub(
    hubId: string,
    ownerUserId: string,
    slice: AgentActionSlice,
  ): Promise<RecordedAgentAction[]> {
    const q = currentManager(this.dataSource)
      .getRepository(AgentActionTypeormEntity)
      .createQueryBuilder('a')
      .where('a.hub_id = :hubId AND a.owner_user_id = :ownerUserId', {
        hubId,
        ownerUserId,
      });
    if (slice.after) q.andWhere('a.id < :after', { after: slice.after });
    const rows = await q
      .orderBy('a.id', 'DESC')
      .limit(slice.limit + 1)
      .getMany();
    return rows.map(toRecorded);
  }
}
