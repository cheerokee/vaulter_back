import { validate } from 'uuid';
import { NotFoundError } from '../../shared/domain/errors.js';
import type { Membership, MembershipContext } from '../domain/membership.js';
import { MembershipRules } from '../domain/membership.js';
import type { MembershipRepository } from '../domain/membership.repository.js';
import type { PermissionKey } from '../domain/rbac-catalog.js';
import type { Organization } from '../domain/organization.js';
import type { OrganizationRepository } from '../domain/organization.repository.js';
import type { RoleAssignmentRepository } from '../domain/role-assignment.repository.js';
import { loadOrganization } from './load-organization.js';
import type { OrganizationAccess } from './organization-access.js';

export type MembershipGuardDeps = {
  access: OrganizationAccess;
  orgs: OrganizationRepository;
  memberships: MembershipRepository;
  roles: RoleAssignmentRepository;
};

/**
 * MUST run inside `UnitOfWork.run`. First a NON-locking membership check (a non-member never takes row locks);
 * then it locks the org_admin assignments (`SELECT ... FOR UPDATE`), so two concurrent remove/demote/leave
 * requests serialize; then re-checks the actor's access under the lock (the authoritative check: `permission`,
 * or plain membership when omitted), reads the target membership and the organization, and derives the context
 * for MembershipRules.
 */
export async function lockMembershipContext(
  deps: MembershipGuardDeps,
  orgId: string,
  targetUserId: string,
  actor: { userId: string; permission?: PermissionKey },
): Promise<{
  target: Membership;
  organization: Organization;
  ctx: MembershipContext;
}> {
  // Ids malformados não chegam ao banco (seriam 22P02 -> 500).
  if (!validate(orgId)) {
    throw new NotFoundError(
      'organization-not-found',
      'The organization was not found.',
    );
  }
  await deps.access.requireMember(orgId, actor.userId);
  const adminIds = await deps.roles.lockOrgAdmins(orgId);
  await (actor.permission
    ? deps.access.requirePermission(orgId, actor.userId, actor.permission)
    : deps.access.requireMember(orgId, actor.userId));
  const target = validate(targetUserId)
    ? await deps.memberships.find(orgId, targetUserId)
    : null;
  if (!target) {
    throw new NotFoundError('member-not-found', 'The member was not found.');
  }
  const organization = await loadOrganization(deps.orgs, orgId);
  return {
    target,
    organization,
    ctx: MembershipRules.contextFor(organization, adminIds, targetUserId),
  };
}
