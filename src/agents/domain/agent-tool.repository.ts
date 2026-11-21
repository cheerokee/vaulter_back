import type { AgentToolDef } from './agent-tool.js';

export abstract class AgentToolRepository {
  /**
   * Makes `tools` the whole catalog of the hub: tombstones what left, upserts the rest (a name that comes back revives
   * its row). REQUIRES an active unit of work; the ambient context must be the hub's (`app.hub_id`) or its owner's.
   * `ownerUserId` is the hub owner, copied for the RLS policy.
   */
  abstract replaceAll(
    hubId: string,
    ownerUserId: string,
    tools: readonly AgentToolDef[],
  ): Promise<void>;
  /** Live tools of the hub by name, read in the ambient context (the hub's or its owner's). */
  abstract listOfHub(hubId: string): Promise<AgentToolDef[]>;
}
