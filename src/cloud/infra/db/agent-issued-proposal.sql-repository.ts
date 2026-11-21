import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AgentTurnView } from '../../../conversations/application/agent-turn.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { hasActiveTransaction } from '../../../shared/infra/db/unit-of-work.js';
import { AgentIssuedProposals } from '../../application/brain/agent-issued-proposals.js';

// As propostas emitidas pelo passo do cérebro, em SQL: transação curta própria no escopo da organização (RLS), só ids e
// hashes. Gravar de novo o mesmo id no mesmo assunto não faz nada (`ON CONFLICT DO NOTHING`; a tabela é só de acréscimo).
@Injectable()
export class AgentIssuedProposalSqlRepository extends AgentIssuedProposals {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async record(
    view: AgentTurnView,
    proposalId: string,
    contentSha256: string,
  ): Promise<void> {
    if (hasActiveTransaction(this.dataSource)) {
      throw new Error(
        'AgentIssuedProposals.record runs in its own short transaction, never inside a unit of work',
      );
    }
    await runInOrganizationScope(this.dataSource, view.organizationId, (m) =>
      m.query(
        `INSERT INTO agent_issued_proposals (organization_id, conversation_id, proposal_id, content_sha256)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conversation_id, proposal_id) DO NOTHING`,
        [view.organizationId, view.conversationId, proposalId, contentSha256],
      ),
    );
  }

  async hashesOf(
    view: AgentTurnView,
    proposalIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (proposalIds.length === 0) return new Map();
    const rows: { proposal_id: string; content_sha256: string }[] =
      await runInOrganizationScope(this.dataSource, view.organizationId, (m) =>
        m.query(
          `SELECT proposal_id, content_sha256 FROM agent_issued_proposals
            WHERE organization_id = $1 AND conversation_id = $2 AND proposal_id = ANY($3::uuid[])`,
          [view.organizationId, view.conversationId, proposalIds],
        ),
      );
    return new Map(rows.map((r) => [r.proposal_id, r.content_sha256]));
  }
}
