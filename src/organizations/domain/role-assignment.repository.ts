import type { PermissionKey } from './rbac-catalog.js';
import type { OrgRoleKey } from './membership.js';

export abstract class RoleAssignmentRepository {
  /** Sets (replaces) the organization-scope role of the user. */
  abstract assignOrgRole(
    orgId: string,
    userId: string,
    roleKey: OrgRoleKey,
    grantedBy: string | null,
  ): Promise<void>;
  /**
   * User ids of the active org_admin assignments of the organization, read with `SELECT ... FOR UPDATE`
   * in the ambient unit of work. Use cases MUST call it inside `UnitOfWork.run`, before evaluating the
   * last-admin rules (`MembershipRules.isLastAdmin`) for remove, demote or leave, so concurrent
   * requests serialize instead of both seeing "another admin exists".
   */
  abstract lockOrgAdmins(orgId: string): Promise<string[]>;
  abstract orgRoleOf(orgId: string, userId: string): Promise<OrgRoleKey | null>;
  abstract permissionsOf(
    orgId: string,
    userId: string,
  ): Promise<PermissionKey[]>;
}
