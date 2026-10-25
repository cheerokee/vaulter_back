import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import {
  SPACE_MAX_MEMBERS,
  SpaceMembershipRules as R,
} from './space-membership.js';

const last = { isLastManager: true, hasOtherMembers: true };
const lastAlone = { isLastManager: true, hasOtherMembers: false };
const notLast = { isLastManager: false, hasOtherMembers: true };

describe('SpaceMembershipRules', () => {
  it('caps the members of a space (409 space-member-limit), 500 by default', () => {
    expect(SPACE_MAX_MEMBERS).toBe(500);
    expect(() => R.assertCanAddMember(2, 3)).not.toThrow();
    for (const count of [3, 4]) {
      expect(() => R.assertCanAddMember(count, 3)).toThrowError(
        expect.objectContaining({
          constructor: ConflictError,
          code: 'space-member-limit',
        }),
      );
    }
    expect(() => R.assertCanAddMember(SPACE_MAX_MEMBERS - 1)).not.toThrow();
    expect(() => R.assertCanAddMember(SPACE_MAX_MEMBERS)).toThrowError(
      expect.objectContaining({ code: 'space-member-limit' }),
    );
  });

  it('accepts only the three space roles', () => {
    for (const k of ['space_reader', 'space_editor', 'space_manager']) {
      expect(R.assertSpaceRole(k)).toBe(k);
    }
    for (const k of ['org_admin', 'owner', '', 'SPACE_READER']) {
      expect(() => R.assertSpaceRole(k)).toThrowError(
        expect.objectContaining({ code: 'role-invalid' }),
      );
    }
  });

  it('isLastManager is true only for a single manager who is the target', () => {
    expect(R.isLastManager(['a'], 'a')).toBe(true);
    expect(R.isLastManager(['a'], 'b')).toBe(false);
    expect(R.isLastManager(['a', 'b'], 'a')).toBe(false);
    expect(R.isLastManager([], 'a')).toBe(false);
  });

  it('blocks removing or leaving the last manager while others remain (422)', () => {
    for (const fn of [
      (...a: Parameters<typeof R.assertCanRemove>) => R.assertCanRemove(...a),
      (...a: Parameters<typeof R.assertCanLeave>) => R.assertCanLeave(...a),
    ]) {
      expect(() => fn('space_manager', last)).toThrowError(
        DomainValidationError,
      );
      expect(() => fn('space_manager', last)).toThrowError(
        expect.objectContaining({ code: 'last-space-manager' }),
      );
    }
  });

  it('allows removing or leaving when not the last manager, a non-manager, or the only member', () => {
    for (const fn of [
      (...a: Parameters<typeof R.assertCanRemove>) => R.assertCanRemove(...a),
      (...a: Parameters<typeof R.assertCanLeave>) => R.assertCanLeave(...a),
    ]) {
      expect(() => fn('space_manager', notLast)).not.toThrow();
      expect(() => fn('space_editor', last)).not.toThrow();
      expect(() => fn('space_manager', lastAlone)).not.toThrow();
    }
  });

  it('blocks demoting the last manager while others remain', () => {
    expect(() =>
      R.assertCanChangeRole('space_manager', 'space_editor', last),
    ).toThrowError(expect.objectContaining({ code: 'last-space-manager' }));
    expect(() =>
      R.assertCanChangeRole('space_manager', 'space_reader', last),
    ).toThrow();
  });

  it('allows other role changes and validates the new role', () => {
    expect(() =>
      R.assertCanChangeRole('space_manager', 'space_manager', last),
    ).not.toThrow();
    expect(() =>
      R.assertCanChangeRole('space_manager', 'space_editor', notLast),
    ).not.toThrow();
    expect(() =>
      R.assertCanChangeRole('space_manager', 'space_editor', lastAlone),
    ).not.toThrow();
    expect(() =>
      R.assertCanChangeRole('space_reader', 'space_manager', last),
    ).not.toThrow();
    expect(() =>
      R.assertCanChangeRole('space_reader', 'boss', notLast),
    ).toThrowError(expect.objectContaining({ code: 'role-invalid' }));
  });

  it('contextFor derives both facts from the lists', () => {
    expect(R.contextFor(['a'], ['a', 'b'], 'a')).toEqual({
      isLastManager: true,
      hasOtherMembers: true,
    });
    expect(R.contextFor(['a'], ['a'], 'a')).toEqual({
      isLastManager: true,
      hasOtherMembers: false,
    });
    expect(R.contextFor(['a', 'b'], ['a', 'b', 'c'], 'a')).toEqual({
      isLastManager: false,
      hasOtherMembers: true,
    });
    expect(R.contextFor(['a'], ['a', 'b'], 'b')).toEqual({
      isLastManager: false,
      hasOtherMembers: true,
    });
  });
});

describe('space role permissions', () => {
  it('mirror the RBAC catalog of organizations', async () => {
    const { FACTORY_ROLES } =
      await import('../../organizations/domain/rbac-catalog.js');
    const { SPACE_ROLE_PERMISSIONS } = await import('./space-membership.js');
    for (const role of [
      'space_reader',
      'space_editor',
      'space_manager',
    ] as const) {
      expect([...SPACE_ROLE_PERMISSIONS[role]].sort()).toEqual(
        [...FACTORY_ROLES[role]].sort(),
      );
    }
  });

  it('hasSpacePermission: only the manager manages members', async () => {
    const { hasSpacePermission } = await import('./space-membership.js');
    expect(hasSpacePermission('space_manager', 'space.members.manage')).toBe(
      true,
    );
    expect(hasSpacePermission('space_editor', 'space.members.manage')).toBe(
      false,
    );
    expect(hasSpacePermission('space_editor', 'memory.write')).toBe(true);
    expect(hasSpacePermission('space_reader', 'memory.write')).toBe(false);
    expect(hasSpacePermission('space_reader', 'memory.read')).toBe(true);
  });
});
