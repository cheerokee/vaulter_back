import type { AssignableHubRole } from './hub-roles.js';

export type HubRoleAssignment = {
  hubId: string;
  userId: string;
  roleKey: AssignableHubRole;
};

export abstract class HubRoleRepository {
  /** Idempotent; revives a tombstone and replaces the role. */
  abstract assign(assignment: HubRoleAssignment): Promise<void>;
  abstract remove(hubId: string, userId: string): Promise<void>;
  abstract list(hubId: string): Promise<HubRoleAssignment[]>;
  /**
   * Tombstones the explicit assignments of users that are no longer active members of any organization linked to
   * the hub; returns the affected user ids.
   */
  abstract removeUsersWithoutLinkedOrg(hubId: string): Promise<string[]>;
}
