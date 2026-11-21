import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { validate } from 'uuid';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import type { AgentRule } from '../../domain/agent-policy.js';
import { AgentPolicyRepository } from '../../domain/agent-policy.repository.js';
import type { AgentPolicy } from '../../domain/agent-policy-version.js';
import { AgentPolicyTypeormEntity } from './agent-policy.entity.js';

// Sempre no escopo da organização (RLS `org_isolation`); dentro de um `uow.run` entra na transação num savepoint.
@Injectable()
export class AgentPolicyTypeormRepository extends AgentPolicyRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async latest(organizationId: string): Promise<AgentPolicy | null> {
    if (!validate(organizationId)) return null;
    const row = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m.getRepository(AgentPolicyTypeormEntity).findOne({
          where: { organizationId },
          order: { version: 'DESC' },
        }),
    );
    return row ? { version: row.version, rules: row.rules } : null;
  }

  async append(input: {
    organizationId: string;
    version: number;
    rules: AgentRule[];
    changedByUserId: string;
  }): Promise<void> {
    await runInOrganizationScope(
      this.dataSource,
      input.organizationId,
      async (m) => {
        // `jsonb` por parâmetro: o driver serializa o array como array do Postgres, então vai como texto.
        await m.query(
          `INSERT INTO agent_policies (organization_id, version, rules, changed_by_user_id)
           VALUES ($1, $2, $3::jsonb, $4)`,
          [
            input.organizationId,
            input.version,
            JSON.stringify(input.rules),
            input.changedByUserId,
          ],
        );
      },
    );
  }
}
