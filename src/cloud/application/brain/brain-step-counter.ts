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
   *
   * Who calls it: the route (`BrainStepUseCase`), ONCE per step after every other check, for the step's first model
   * call; the `BrainComposer`, only before each ADDITIONAL model call inside the same step. On `'limit'` mid-step the
   * composer makes no further call and returns the last model text as `final`. A budget-refused or failed step keeps
   * the slot it used.
   */
  abstract consume(view: AgentTurnView): Promise<'ok' | 'limit'>;
  /** Adds the settled cost of a call to the message's row (Task 11, after `AiBudget.settle`). */
  abstract addCost(view: AgentTurnView, costMicroUsd: bigint): Promise<void>;
  /**
   * The ids of the chunks retrieved by the message's first model call (spec pc-agent §5.3: retrieval only once per
   * message), or `null` when none was recorded yet (then this step retrieves). Only ids: never the text.
   */
  abstract chunkIdsOf(view: AgentTurnView): Promise<string[] | null>;
  /** Records the retrieved chunk ids (possibly none) once: a later record never replaces the first. */
  abstract recordChunkIds(
    view: AgentTurnView,
    chunkIds: readonly string[],
  ): Promise<void>;
}
