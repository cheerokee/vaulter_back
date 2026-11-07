import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import type {
  PlatformPermission,
  PlatformRoleKey,
} from './platform-catalog.js';

/** A staff member as stored: the user and their live platform roles (names/e-mails come from the identity). */
export type StaffRoles = { userId: string; roles: PlatformRoleKey[] };

// Atribuições de papel da plataforma (user_platform_role). Sem RLS: as tabelas da plataforma não têm organização.
export abstract class PlatformRoleRepository {
  /** Permissions of the user's live roles, without repetition, in key order. */
  abstract permissionsOf(userId: string): Promise<PlatformPermission[]>;
  /** Live roles of the user, in key order. */
  abstract rolesOf(userId: string): Promise<PlatformRoleKey[]>;
  abstract hasAnyRole(userId: string): Promise<boolean>;
  /** Gives the role (reviving the tombstoned row if there is one). True when it changed something. */
  abstract grant(
    userId: string,
    roleKey: PlatformRoleKey,
    now: Date,
  ): Promise<boolean>;
  /** Tombstones the live assignment. True when it changed something. */
  abstract revoke(
    userId: string,
    roleKey: PlatformRoleKey,
    now: Date,
  ): Promise<boolean>;
  /**
   * Locks (FOR UPDATE, in user id order) the live `platform_admin` assignments and returns their user ids. Needs
   * an active unit of work: the lock lasts until the caller's transaction ends.
   */
  abstract lockAdmins(): Promise<string[]>;
  /**
   * Locks FOR SHARE (in user id order) the same live `platform_admin` assignments. Support request creation and
   * decisions take it before re-checking permissions and the staff target, so a role grant/revoke (which starts with
   * `lockAdmins`, FOR UPDATE) waits for them and they wait for it: no decision runs on a role read before a change
   * that was committed meanwhile. Needs an active unit of work.
   */
  abstract lockAdminsForShare(): Promise<void>;
  /** Users with at least one live role, by user id (cursor). */
  abstract listStaff(page: CursorPageRequest): Promise<CursorPage<StaffRoles>>;
}
