import type { AgentRule } from './agent-policy.js';
import type { AgentPolicy } from './agent-policy-version.js';

export abstract class AgentPolicyRepository {
  /** The highest version of the organization, read in its scope (no lock); null when it never had a policy. */
  abstract latest(organizationId: string): Promise<AgentPolicy | null>;
  /**
   * Appends a new version (append-only: nothing is updated or deleted). REQUIRES an active unit of work, with the
   * organization locked by the caller (`OrganizationDirectory.lockForAgentPolicy`) and the version already checked.
   */
  abstract append(input: {
    organizationId: string;
    version: number;
    rules: AgentRule[];
    changedByUserId: string;
  }): Promise<void>;
}
