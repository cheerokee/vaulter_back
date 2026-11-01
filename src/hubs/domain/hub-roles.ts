import {
  DomainValidationError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';

/** Roles the owner may assign to members of linked organizations. */
export const ASSIGNABLE_HUB_ROLES = ['hub_operator', 'hub_user'] as const;
export type AssignableHubRole = (typeof ASSIGNABLE_HUB_ROLES)[number];
/** hub_owner (the owner) and hub_room (the Room) are system-managed, never assigned through the API. */
export const SYSTEM_HUB_ROLES = ['hub_owner', 'hub_room'] as const;

export const HubRoleRules = {
  assertAssignable(roleKey: string): AssignableHubRole {
    if (!(ASSIGNABLE_HUB_ROLES as readonly string[]).includes(roleKey)) {
      throw new DomainValidationError(
        'role-invalid',
        'Only hub_operator or hub_user can be assigned.',
      );
    }
    return roleKey as AssignableHubRole;
  },

  /** The owner keeps hub_owner; they cannot assign or remove a role for themselves. */
  assertNotOwner(ownerUserId: string, targetUserId: string): void {
    if (ownerUserId === targetUserId) {
      throw new PermissionDeniedError(
        'hub-owner-protected',
        "The hub owner's role cannot be changed.",
      );
    }
  },
};
