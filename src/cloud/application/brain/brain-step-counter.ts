import type { AgentTurnView } from '../../../conversations/application/agent-turn.js';

/**
 * Model calls per answered message (spec pc-agent §5.3, "Contagem dos passos"; table `agent_brain_steps`, only ids and
 * numbers). The back counts calls, never the agent's `stepIndex`: repeating a step after a crash counts (and is billed)
 * again.
 */
export abstract class BrainStepCounter {
  /**
   * Counts one more model call for the message, in its OWN short transaction (never inside a unit of work): `'ok'` when
   * it was below `BRAIN_MAX_CALLS` (now one more), `'limit'` when it already had them (nothing changes). Atomic: two
   * concurrent steps never pass the limit together.
   */
  abstract consume(view: AgentTurnView): Promise<'ok' | 'limit'>;
  /** Adds the settled cost of a call to the message's row (Task 11, after `AiBudget.settle`). */
  abstract addCost(view: AgentTurnView, costMicroUsd: bigint): Promise<void>;
}
