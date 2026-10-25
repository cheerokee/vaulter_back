import type { SpaceRoleKey } from './space-membership.js';

export abstract class SpaceRoleRepository {
  /** Sets (replaces) the user's role in the space; clears a tombstone. */
  abstract assign(
    orgId: string,
    spaceId: string,
    userId: string,
    roleKey: SpaceRoleKey,
    grantedBy: string | null,
  ): Promise<void>;
  abstract roleOf(
    orgId: string,
    spaceId: string,
    userId: string,
  ): Promise<SpaceRoleKey | null>;
  abstract remove(
    orgId: string,
    spaceId: string,
    userId: string,
  ): Promise<void>;
  abstract activeMemberIds(orgId: string, spaceId: string): Promise<string[]>;
  /**
   * User ids of the active space_manager assignments, read with `SELECT ... FOR UPDATE` in a stable order.
   * REQUIRES an active unit of work; call it before evaluating `SpaceMembershipRules.isLastManager` for
   * remove, demote or leave, so concurrent requests serialize.
   */
  abstract lockSpaceManagers(orgId: string, spaceId: string): Promise<string[]>;
  /** Tombstones the user's space assignments in the organization; returns the affected space ids. */
  abstract removeUserInOrg(orgId: string, userId: string): Promise<string[]>;
}
