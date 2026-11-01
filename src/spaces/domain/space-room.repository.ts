import type { SpaceRoleKey } from './space-membership.js';

/**
 * A Hub's Room in a space: one role_assignments row (`room_hub_id`, scope `space`) plus the Hub's sealed copy of
 * every key version (`space_key_grants.hub_id`). Every method takes `orgId` first (RLS context and filter).
 * The `hubs` table belongs to another module: here a hub is just an id.
 */
export abstract class SpaceRoomRepository {
  /** Hubs with the space open in their Room (active role), sorted. */
  abstract roomHubIds(orgId: string, spaceId: string): Promise<string[]>;
  /** Sets (replaces) the Room's role in the space; clears a tombstone (one row per hub and space). */
  abstract assignRoom(
    orgId: string,
    spaceId: string,
    hubId: string,
    roleKey: SpaceRoleKey,
    grantedBy: string | null,
  ): Promise<void>;
  /** Inserts or updates the Hub's copy of one version; clears the tombstone of a returning Room. */
  abstract upsertHubGrant(
    orgId: string,
    spaceKeyId: string,
    hubId: string,
    wrappedKey: string,
  ): Promise<void>;
  /** Tombstones the Room's role and every copy of the hub in the space; true when something was active. */
  abstract removeRoom(
    orgId: string,
    spaceId: string,
    hubId: string,
  ): Promise<boolean>;
  /** Spaces of the organization where the hub has a Room role or a copy (active), sorted. */
  abstract roomSpaceIdsOfHub(orgId: string, hubId: string): Promise<string[]>;
  /** Tombstones the hub's Room roles and copies in every space of the organization; returns the space ids. */
  abstract removeHubInOrg(orgId: string, hubId: string): Promise<string[]>;
}
