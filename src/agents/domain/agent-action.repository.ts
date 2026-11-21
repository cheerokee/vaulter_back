import type { AgentActionItem } from './agent-action.js';

/** A recorded action as listed: the item plus where it happened and who owns the agent. */
export type RecordedAgentAction = AgentActionItem & {
  /** Internal row id, UUID v7: the order and the cursor of the listings. */
  rowId: string;
  organizationId: string;
  spaceId: string;
  hubId: string;
  ownerUserId: string;
  recordedAt: Date;
};

export type AgentActionFilter = { userId?: string; hubId?: string };
export type AgentActionSlice = { after?: string; limit: number };

export abstract class AgentActionRepository {
  /** The recorded items of the hub among `actionIds`, read in the organization's scope (none from another one). */
  abstract findByIds(
    organizationId: string,
    hubId: string,
    actionIds: readonly string[],
  ): Promise<Map<string, AgentActionItem>>;
  /**
   * Appends the rows in the organization's scope (`ON CONFLICT DO NOTHING` on `(hub_id, action_id)`: append-only, nothing
   * is ever updated) and returns the ids of the ones written now. REQUIRES an active unit of work.
   */
  abstract insertMany(input: {
    organizationId: string;
    hubId: string;
    ownerUserId: string;
    rows: readonly { item: AgentActionItem; spaceId: string }[];
  }): Promise<string[]>;
  /** Newest first, at most `limit + 1` rows after `after` (row id, exclusive). Organization scope, filtered by it. */
  abstract listOfOrganization(
    organizationId: string,
    filter: AgentActionFilter,
    slice: AgentActionSlice,
  ): Promise<RecordedAgentAction[]>;
  /** Same, the actions of one hub for its owner (the owner's context; every organization the agent acted in). */
  abstract listOfHub(
    hubId: string,
    ownerUserId: string,
    slice: AgentActionSlice,
  ): Promise<RecordedAgentAction[]>;
}
