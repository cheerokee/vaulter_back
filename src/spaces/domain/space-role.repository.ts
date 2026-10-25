import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import type { SpaceRoleKey } from './space-membership.js';

export type SpaceMember = {
  userId: string;
  roleKey: SpaceRoleKey;
  joinedAt: Date;
};

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
  /** Active space-scope assignments, with role. */
  abstract listMembers(
    orgId: string,
    spaceId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<SpaceMember>>;
  /**
   * User ids of the active space_manager assignments, read with `SELECT ... FOR UPDATE` in a stable order.
   * REQUIRES an active unit of work; call it before evaluating `SpaceMembershipRules.isLastManager` for
   * remove, demote or leave, so concurrent requests serialize.
   */
  abstract lockSpaceManagers(orgId: string, spaceId: string): Promise<string[]>;
  /**
   * Organization of the space when `userId` is an ACTIVE member of it, else null. Runs with only
   * `app.user_id` (policy self_read of role_assignments): it reads the user's own rows, so a space id of
   * another organization (or one the user is not in) never resolves.
   */
  abstract findOrganizationOfMember(
    spaceId: string,
    userId: string,
  ): Promise<string | null>;
  /** Ids of the spaces where the user is an active member in the organization, sorted. */
  abstract spaceIdsOfUser(orgId: string, userId: string): Promise<string[]>;
  /** Tombstones the user's space assignments in the organization; returns the affected space ids. */
  abstract removeUserInOrg(orgId: string, userId: string): Promise<string[]>;
}
