import { ConflictError } from '../../shared/domain/errors.js';
import type { AgentEffect } from './agent-policy.js';

/** Items per `POST /hub/agent/actions` (spec pc-agent §5.6). */
export const AGENT_ACTIONS_BATCH_MAX = 100;

export const AGENT_ACTION_EFFECTS = ['allow', 'confirm', 'deny'] as const;
export const AGENT_ACTION_DECISIONS = [
  'executed',
  'declined',
  'blocked',
  'failed',
] as const;

/** What happened to a tool call: ran, the person declined the confirmation, the ACL blocked it, or it failed. */
export type AgentActionDecision = (typeof AGENT_ACTION_DECISIONS)[number];

/**
 * One audited action of the agent (spec §5.6). It NEVER carries arguments, results, paths or URLs: only who asked
 * (conversation and message), which tool, the ACL effect that applied, what came of it, and the policy version.
 * `id` is made by the agent (UUID), which makes the report idempotent.
 */
export type AgentActionItem = {
  id: string;
  conversationId: string;
  messageId: string;
  toolName: string;
  effect: AgentEffect;
  decision: AgentActionDecision;
  startedAt: Date;
  durationMs: number;
  policyVersion: number;
};

const idConflict = () =>
  new ConflictError(
    'agent-action-id-conflict',
    'An action with this id was already recorded with different content.',
  );

export function sameAgentAction(a: AgentActionItem, b: AgentActionItem) {
  return (
    a.id === b.id &&
    a.conversationId === b.conversationId &&
    a.messageId === b.messageId &&
    a.toolName === b.toolName &&
    a.effect === b.effect &&
    a.decision === b.decision &&
    a.startedAt.getTime() === b.startedAt.getTime() &&
    a.durationMs === b.durationMs &&
    a.policyVersion === b.policyVersion
  );
}

/** Same id twice in one batch: identical = one item (order kept); different content = 409 `agent-action-id-conflict`. */
export function dedupeAgentActions(
  items: readonly AgentActionItem[],
): AgentActionItem[] {
  const seen = new Map<string, AgentActionItem>();
  for (const it of items) {
    const prior = seen.get(it.id);
    if (!prior) seen.set(it.id, it);
    else if (!sameAgentAction(prior, it)) throw idConflict();
  }
  return [...seen.values()];
}

/** What still has to be written: an id already recorded with the same content is a no-op, with another one is 409. */
export function newAgentActions(
  items: readonly AgentActionItem[],
  recorded: ReadonlyMap<string, AgentActionItem>,
): AgentActionItem[] {
  const fresh: AgentActionItem[] = [];
  for (const it of items) {
    const prior = recorded.get(it.id);
    if (!prior) fresh.push(it);
    else if (!sameAgentAction(prior, it)) throw idConflict();
  }
  return fresh;
}
