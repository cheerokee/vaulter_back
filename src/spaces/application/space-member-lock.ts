import { validate } from 'uuid';
import { NotFoundError } from '../../shared/domain/errors.js';
import type { Space } from '../domain/space.js';
import {
  SpaceMembershipRules,
  type SpaceMembershipContext,
  type SpaceRoleKey,
} from '../domain/space-membership.js';
import type { SpaceRoleRepository } from '../domain/space-role.repository.js';

export function spaceMemberNotFound(): NotFoundError {
  return new NotFoundError(
    'space-member-not-found',
    'The member was not found in the space.',
  );
}

/**
 * MUST run inside `UnitOfWork.run`, with the space already locked (`SpaceAccess.lockAsMember`). Locks the
 * active space_manager assignments (`FOR UPDATE`), reads the target's role and the active members, and builds
 * the context for the last-manager rule. A target that is not in the space (or a malformed id): 404.
 */
export async function lockSpaceMemberContext(
  roles: SpaceRoleRepository,
  space: Space,
  targetUserId: string,
): Promise<{ targetRole: SpaceRoleKey; ctx: SpaceMembershipContext }> {
  const orgId = space.organizationId;
  const managerIds = await roles.lockSpaceManagers(orgId, space.id);
  const targetRole = validate(targetUserId)
    ? await roles.roleOf(orgId, space.id, targetUserId)
    : null;
  if (!targetRole) throw spaceMemberNotFound();
  const memberIds = await roles.activeMemberIds(orgId, space.id);
  return {
    targetRole,
    ctx: SpaceMembershipRules.contextFor(managerIds, memberIds, targetUserId),
  };
}
