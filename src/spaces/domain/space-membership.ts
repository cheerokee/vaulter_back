import { DomainValidationError } from '../../shared/domain/errors.js';

export const SPACE_ROLE_KEYS = [
  'space_reader',
  'space_editor',
  'space_manager',
] as const;
export type SpaceRoleKey = (typeof SPACE_ROLE_KEYS)[number];

export function isSpaceRoleKey(value: unknown): value is SpaceRoleKey {
  return (SPACE_ROLE_KEYS as readonly unknown[]).includes(value);
}

/** Facts read by the caller under lock (SpaceRoleRepository.lockSpaceManagers). */
export type SpaceMembershipContext = {
  /** the target is the only active manager. */
  isLastManager: boolean;
  /** there are active members besides the target. */
  hasOtherMembers: boolean;
};

function lastManager(): never {
  throw new DomainValidationError(
    'last-space-manager',
    'The space must keep at least one manager while it has other members.',
  );
}

export const SpaceMembershipRules = {
  /** Builds the context from the locked manager list and the active members (no trust in callers). */
  contextFor(
    managerIds: readonly string[],
    memberIds: readonly string[],
    targetUserId: string,
  ): SpaceMembershipContext {
    return {
      isLastManager: SpaceMembershipRules.isLastManager(
        managerIds,
        targetUserId,
      ),
      hasOtherMembers: memberIds.some((id) => id !== targetUserId),
    };
  },

  assertSpaceRole(roleKey: string): SpaceRoleKey {
    if (!isSpaceRoleKey(roleKey)) {
      throw new DomainValidationError(
        'role-invalid',
        'The role must be space_reader, space_editor or space_manager.',
      );
    }
    return roleKey;
  },

  /** `managerIds` = active space_manager user ids, read under lock. */
  isLastManager(managerIds: readonly string[], targetUserId: string): boolean {
    return managerIds.length === 1 && managerIds[0] === targetUserId;
  },

  assertCanRemove(targetRole: SpaceRoleKey, ctx: SpaceMembershipContext): void {
    if (
      targetRole === 'space_manager' &&
      ctx.isLastManager &&
      ctx.hasOtherMembers
    ) {
      lastManager();
    }
  },

  /** Leaving as the only member is allowed: the space becomes an orphan (reopened with the kit). */
  assertCanLeave(targetRole: SpaceRoleKey, ctx: SpaceMembershipContext): void {
    SpaceMembershipRules.assertCanRemove(targetRole, ctx);
  },

  assertCanChangeRole(
    targetRole: SpaceRoleKey,
    newRole: string,
    ctx: SpaceMembershipContext,
  ): void {
    SpaceMembershipRules.assertSpaceRole(newRole);
    if (
      targetRole === 'space_manager' &&
      newRole !== 'space_manager' &&
      ctx.isLastManager &&
      ctx.hasOtherMembers
    ) {
      lastManager();
    }
  },
};
