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
  abstract orgRoleOf(orgId: string, userId: string): Promise<OrgRoleKey | null>;
  abstract permissionsOf(
    orgId: string,
    userId: string,
  ): Promise<PermissionKey[]>;
}
