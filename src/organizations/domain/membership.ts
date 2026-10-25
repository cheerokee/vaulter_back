import { DomainValidationError } from '../../shared/domain/errors.js';

export const ORG_ROLE_KEYS = ['org_admin', 'org_member'] as const;
export type OrgRoleKey = (typeof ORG_ROLE_KEYS)[number];

export function isOrgRoleKey(value: unknown): value is OrgRoleKey {
  return (ORG_ROLE_KEYS as readonly unknown[]).includes(value);
}

export type Membership = {
  organizationId: string;
  userId: string;
  roleKey: OrgRoleKey;
  joinedAt?: Date;
};

export type MembershipTarget = { userId: string; roleKey: string };

/** Facts the caller reads from the repository (inside the transaction/lock). */
export type MembershipContext = {
  /** removing/demoting/leaving this member would leave zero org_admin. */
  isLastAdmin: boolean;
  isPersonalOwner: boolean;
};

function fail(code: string, message: string): never {
  throw new DomainValidationError(code, message);
}

export const MembershipRules = {
  assertCanRemove(target: MembershipTarget, ctx: MembershipContext): void {
    void target;
    if (ctx.isPersonalOwner) {
      fail(
        'personal-owner-protected',
        'The owner of a personal organization cannot be removed.',
      );
    }
    if (ctx.isLastAdmin) {
      fail('last-admin', 'The organization must keep at least one admin.');
    }
  },

  assertCanChangeRole(
    target: MembershipTarget,
    newRole: string,
    ctx: MembershipContext,
  ): void {
    if (!isOrgRoleKey(newRole) || !isOrgRoleKey(target.roleKey)) {
      fail('role-invalid', 'The role must be org_admin or org_member.');
    }
    if (target.roleKey === 'org_admin' && newRole === 'org_member') {
      if (ctx.isPersonalOwner) {
        fail(
          'personal-owner-protected',
          'The owner of a personal organization cannot be demoted.',
        );
      }
      if (ctx.isLastAdmin) {
        fail('last-admin', 'The organization must keep at least one admin.');
      }
    }
  },

  assertCanLeave(ctx: MembershipContext): void {
    if (ctx.isPersonalOwner) {
      fail(
        'cannot-leave-personal',
        'The owner cannot leave their personal organization.',
      );
    }
    if (ctx.isLastAdmin) {
      fail('last-admin', 'The organization must keep at least one admin.');
    }
  },
};
