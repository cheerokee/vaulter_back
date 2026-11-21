import { Injectable } from '@nestjs/common';
import { AgentPolicyRepository } from '../domain/agent-policy.repository.js';
import {
  type AgentPolicy,
  EMPTY_AGENT_POLICY,
} from '../domain/agent-policy-version.js';

/**
 * The current policy of an organization, for the next tasks (the brain step reads it to filter the tools and mark the
 * effect of each call). A plain read in the organization scope, no lock, no authorization: the caller already knows
 * the organization is the one it may act for. No row = `{ version: 0, rules: [] }` (no rule is deny).
 */
@Injectable()
export class AgentPolicyReader {
  constructor(private readonly policies: AgentPolicyRepository) {}

  async current(orgId: string): Promise<AgentPolicy> {
    const latest = await this.policies.latest(orgId);
    return latest
      ? { version: latest.version, rules: latest.rules }
      : { ...EMPTY_AGENT_POLICY };
  }
}
