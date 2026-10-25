import { DomainValidationError } from '../../shared/domain/errors.js';
import { Organization } from './organization.js';
import { MembershipRules } from './membership.js';

const admin = { userId: 'u1', roleKey: 'org_admin' } as const;
const member = { userId: 'u2', roleKey: 'org_member' } as const;
const free = { isLastAdmin: false, isPersonalOwner: false };

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainValidationError);
    return (e as DomainValidationError).code;
  }
  return undefined;
}

describe('MembershipRules', () => {
  it('allows removing a regular member or a non-last admin', () => {
    expect(codeOf(() => MembershipRules.assertCanRemove(member, free))).toBe(
      undefined,
    );
    expect(codeOf(() => MembershipRules.assertCanRemove(admin, free))).toBe(
      undefined,
    );
  });

  it('refuses removing the last admin', () => {
    expect(
      codeOf(() =>
        MembershipRules.assertCanRemove(admin, { ...free, isLastAdmin: true }),
      ),
    ).toBe('last-admin');
  });

  it('protects the personal owner from removal (before last-admin)', () => {
    expect(
      codeOf(() =>
        MembershipRules.assertCanRemove(admin, {
          isLastAdmin: true,
          isPersonalOwner: true,
        }),
      ),
    ).toBe('personal-owner-protected');
  });

  it('changes role only between org_admin and org_member', () => {
    expect(
      codeOf(() =>
        MembershipRules.assertCanChangeRole(member, 'org_admin', free),
      ),
    ).toBe(undefined);
    expect(
      codeOf(() =>
        MembershipRules.assertCanChangeRole(member, 'space_reader', free),
      ),
    ).toBe('role-invalid');
    expect(
      codeOf(() =>
        MembershipRules.assertCanChangeRole(
          { userId: 'u', roleKey: 'hub_owner' },
          'org_member',
          free,
        ),
      ),
    ).toBe('role-invalid');
  });

  it('refuses demoting the last admin and the personal owner', () => {
    expect(
      codeOf(() =>
        MembershipRules.assertCanChangeRole(admin, 'org_member', {
          ...free,
          isLastAdmin: true,
        }),
      ),
    ).toBe('last-admin');
    expect(
      codeOf(() =>
        MembershipRules.assertCanChangeRole(admin, 'org_member', {
          ...free,
          isPersonalOwner: true,
        }),
      ),
    ).toBe('personal-owner-protected');
  });

  it('allows a no-op or a promotion even for the last admin', () => {
    const last = { isLastAdmin: true, isPersonalOwner: true };
    expect(
      codeOf(() =>
        MembershipRules.assertCanChangeRole(admin, 'org_admin', last),
      ),
    ).toBe(undefined);
  });

  it('refuses leaving: personal owner and last admin', () => {
    expect(codeOf(() => MembershipRules.assertCanLeave(free))).toBe(undefined);
    expect(
      codeOf(() =>
        MembershipRules.assertCanLeave({ ...free, isLastAdmin: true }),
      ),
    ).toBe('last-admin');
    expect(
      codeOf(() =>
        MembershipRules.assertCanLeave({
          isLastAdmin: true,
          isPersonalOwner: true,
        }),
      ),
    ).toBe('cannot-leave-personal');
  });

  it('derives isLastAdmin from the locked admin list', () => {
    expect(MembershipRules.isLastAdmin(['u1'], 'u1')).toBe(true);
    expect(MembershipRules.isLastAdmin(['u1', 'u3'], 'u1')).toBe(false);
    expect(MembershipRules.isLastAdmin(['u1'], 'u2')).toBe(false);
    expect(MembershipRules.isLastAdmin([], 'u1')).toBe(false);
  });

  it('builds the context from the organization and admin list', () => {
    const org = Organization.createPersonal({
      name: 'Ana',
      ownerId: 'u1',
      now: new Date(),
    });
    expect(MembershipRules.contextFor(org, ['u1'], 'u1')).toEqual({
      isLastAdmin: true,
      isPersonalOwner: true,
    });
    expect(MembershipRules.contextFor(org, ['u1', 'u2'], 'u2')).toEqual({
      isLastAdmin: false,
      isPersonalOwner: false,
    });
  });
});
