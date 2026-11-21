import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AgentTurnView } from '../../../conversations/application/agent-turn.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { hasActiveTransaction } from '../../../shared/infra/db/unit-of-work.js';
import { BrainStepCounter } from '../../application/brain/brain-step-counter.js';
import { BRAIN_MAX_CALLS } from '../../domain/brain-step.js';

// O contador em SQL: um comando só (`INSERT ... ON CONFLICT DO UPDATE ... WHERE calls < limite RETURNING`), então dois
// passos ao mesmo tempo nunca passam do limite juntos (o segundo espera a trava da linha e relê `calls`). Nenhuma linha
// devolvida = o limite já tinha sido atingido. Transação curta própria, no escopo da organização (RLS).
@Injectable()
export class AgentBrainStepSqlRepository extends BrainStepCounter {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async consume(view: AgentTurnView): Promise<'ok' | 'limit'> {
    if (hasActiveTransaction(this.dataSource)) {
      throw new Error(
        'BrainStepCounter.consume runs in its own short transaction, never inside a unit of work',
      );
    }
    const rows: unknown[] = await runInOrganizationScope(
      this.dataSource,
      view.organizationId,
      (m) =>
        m.query(
          `INSERT INTO agent_brain_steps (organization_id, conversation_id, message_id, calls)
           VALUES ($1, $2, $3, 1)
           ON CONFLICT (conversation_id, message_id) DO UPDATE
              SET calls = agent_brain_steps.calls + 1, updated_at = now()
            WHERE agent_brain_steps.calls < $4
           RETURNING calls`,
          [
            view.organizationId,
            view.conversationId,
            view.messageId,
            BRAIN_MAX_CALLS,
          ],
        ),
    );
    return rows.length > 0 ? 'ok' : 'limit';
  }

  async addCost(view: AgentTurnView, costMicroUsd: bigint): Promise<void> {
    if (costMicroUsd < 0n) throw new Error('costMicroUsd must be >= 0');
    await runInOrganizationScope(this.dataSource, view.organizationId, (m) =>
      m.query(
        `UPDATE agent_brain_steps
            SET cost_micro_usd = cost_micro_usd + $4, updated_at = now()
          WHERE organization_id = $1 AND conversation_id = $2 AND message_id = $3`,
        [
          view.organizationId,
          view.conversationId,
          view.messageId,
          costMicroUsd.toString(),
        ],
      ),
    );
  }

  async chunkIdsOf(view: AgentTurnView): Promise<string[] | null> {
    const rows: { chunk_ids: string[] | null }[] = await runInOrganizationScope(
      this.dataSource,
      view.organizationId,
      (m) =>
        m.query(
          `SELECT chunk_ids FROM agent_brain_steps
            WHERE organization_id = $1 AND conversation_id = $2 AND message_id = $3`,
          [view.organizationId, view.conversationId, view.messageId],
        ),
    );
    return rows[0]?.chunk_ids ?? null;
  }

  async recordChunkIds(
    view: AgentTurnView,
    chunkIds: readonly string[],
  ): Promise<void> {
    await runInOrganizationScope(this.dataSource, view.organizationId, (m) =>
      m.query(
        `UPDATE agent_brain_steps SET chunk_ids = $4::uuid[], updated_at = now()
          WHERE organization_id = $1 AND conversation_id = $2 AND message_id = $3 AND chunk_ids IS NULL`,
        [view.organizationId, view.conversationId, view.messageId, chunkIds],
      ),
    );
  }
}
