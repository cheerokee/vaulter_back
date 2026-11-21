import { ConflictError } from '../../shared/domain/errors.js';
import type { AgentRule } from './agent-policy.js';

/** The policy of an organization at one version. Version 0 is "no policy yet": no rules, so everything is denied. */
export type AgentPolicy = { version: number; rules: AgentRule[] };

/** What an organization has before anyone writes a policy. */
export const EMPTY_AGENT_POLICY: AgentPolicy = { version: 0, rules: [] };

/**
 * The version a replacement gets: always `current + 1`, and only when the writer started from the current version
 * (`baseVersion`). Anything else (someone else changed it first, or a version from the future) is 409
 * `agent-policy-version-stale`, and nothing is written.
 */
export function nextPolicyVersion(
  currentVersion: number,
  baseVersion: number,
): number {
  if (baseVersion !== currentVersion) {
    throw new ConflictError(
      'agent-policy-version-stale',
      'The policy changed since you loaded it. Reload and try again.',
      { currentVersion },
    );
  }
  return currentVersion + 1;
}
