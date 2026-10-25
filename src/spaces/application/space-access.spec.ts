import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import {
  ADMIN,
  EDITOR,
  KIT_PK,
  MANAGER,
  OLD_KIT_PK,
  ORG_ID,
  OTHER_ADMIN,
  OTHER_ORG,
  OTHER_SPACE,
  OUTSIDER,
  READER,
  SPACE_ID,
  STRANGER,
  fp,
  makeSpaceKit,
} from '../../../test/support/spaces-kit.js';

const kit = makeSpaceKit();
const access = kit.deps.access;
const m = kit.mocks;
const NOT_FOUND = { constructor: NotFoundError, code: 'space-not-found' };
const DENIED = {
  constructor: PermissionDeniedError,
  code: 'permission-denied',
};

beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
});

describe('SpaceAccess.requireSpaceMember', () => {
  it('resolves the space of a member in its organization, with the role', async () => {
    const { space, roleKey } = await access.requireSpaceMember(
      SPACE_ID,
      READER,
    );
    expect(space.id).toBe(SPACE_ID);
    expect(space.organizationId).toBe(ORG_ID);
    expect(roleKey).toBe('space_reader');
    expect(m.roles.roleOf).toHaveBeenCalledWith(ORG_ID, SPACE_ID, READER);
  });

  it('404 for the org admin outside the space, an org member outside it, a stranger and another org', async () => {
    for (const userId of [ADMIN, OUTSIDER, STRANGER, OTHER_ADMIN]) {
      await expect(
        access.requireSpaceMember(SPACE_ID, userId),
      ).rejects.toMatchObject(NOT_FOUND);
    }
    // a valid space id of another organization
    await expect(
      access.requireSpaceMember(OTHER_SPACE, MANAGER),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('404 without touching the database for malformed ids', async () => {
    await expect(
      access.requireSpaceMember('nope', READER),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      access.requireSpaceMember(SPACE_ID, 'nope'),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(m.roles.findOrganizationOfMember).not.toHaveBeenCalled();
  });

  it('404 when the user is no longer an active member of the organization', async () => {
    kit.orgMembers.get(ORG_ID)!.delete(READER);
    await expect(
      access.requireSpaceMember(SPACE_ID, READER),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('404 when the space row is gone (tombstoned)', async () => {
    m.spaces.findById.mockResolvedValueOnce(null);
    await expect(
      access.requireSpaceMember(SPACE_ID, READER),
    ).rejects.toMatchObject(NOT_FOUND);
  });
});

describe('SpaceAccess.requireSpacePermission', () => {
  it('a member without the permission gets 403; the manager passes', async () => {
    await expect(
      access.requireSpacePermission(SPACE_ID, EDITOR, 'space.members.manage'),
    ).rejects.toMatchObject(DENIED);
    await expect(
      access.requireSpacePermission(SPACE_ID, READER, 'memory.write'),
    ).rejects.toMatchObject(DENIED);
    await expect(
      access.requireSpacePermission(SPACE_ID, EDITOR, 'memory.write'),
    ).resolves.toMatchObject({ roleKey: 'space_editor' });
    await expect(
      access.requireSpacePermission(SPACE_ID, MANAGER, 'space.members.manage'),
    ).resolves.toMatchObject({ roleKey: 'space_manager' });
  });

  it('a non-member gets 404, never 403', async () => {
    await expect(
      access.requireSpacePermission(SPACE_ID, ADMIN, 'space.members.manage'),
    ).rejects.toMatchObject(NOT_FOUND);
  });
});

describe('SpaceAccess.lockAsMember', () => {
  it('pre-checks without a lock, then locks and re-checks the role under the lock', async () => {
    const { space, roleKey } = await access.lockAsMember(
      SPACE_ID,
      MANAGER,
      'space.members.manage',
    );
    expect(space.id).toBe(SPACE_ID);
    expect(roleKey).toBe('space_manager');
    const lock = kit.trace.indexOf('spaces.lockForUpdate@out');
    expect(lock).toBeGreaterThan(0);
    expect(kit.trace.indexOf('roles.roleOf@out', lock)).toBeGreaterThan(lock);
  });

  it('a non-member never takes the lock', async () => {
    await expect(access.lockAsMember(SPACE_ID, ADMIN)).rejects.toMatchObject(
      NOT_FOUND,
    );
    expect(m.spaces.lockForUpdate).not.toHaveBeenCalled();
  });

  it('a member without the permission never takes the lock (403)', async () => {
    await expect(
      access.lockAsMember(SPACE_ID, READER, 'space.members.manage'),
    ).rejects.toMatchObject(DENIED);
    expect(m.spaces.lockForUpdate).not.toHaveBeenCalled();
  });

  it('role lost or demoted between the pre-check and the lock: 404 / 403', async () => {
    m.roles.roleOf
      .mockResolvedValueOnce('space_manager')
      .mockResolvedValueOnce(null);
    await expect(
      access.lockAsMember(SPACE_ID, MANAGER, 'space.members.manage'),
    ).rejects.toMatchObject(NOT_FOUND);
    m.roles.roleOf
      .mockResolvedValueOnce('space_manager')
      .mockResolvedValueOnce('space_reader');
    await expect(
      access.lockAsMember(SPACE_ID, MANAGER, 'space.members.manage'),
    ).rejects.toMatchObject(DENIED);
  });

  it('the space vanished before the lock: 404', async () => {
    m.spaces.lockForUpdate.mockResolvedValueOnce(null);
    await expect(access.lockAsMember(SPACE_ID, READER)).rejects.toMatchObject(
      NOT_FOUND,
    );
  });
});

describe('SpaceAccess.requireOrgPermissionForSpace (admin-only operations)', () => {
  it('an org admin outside the space resolves it through the organization', async () => {
    const space = await access.requireOrgPermissionForSpace(
      SPACE_ID,
      ADMIN,
      'org.members.manage',
    );
    expect(space.id).toBe(SPACE_ID);
    expect(m.spaces.findById).toHaveBeenCalledWith(ORG_ID, SPACE_ID);
  });

  it('the admin of another organization, a stranger and an org member outside the space get 404', async () => {
    for (const userId of [OTHER_ADMIN, STRANGER, OUTSIDER]) {
      await expect(
        access.requireOrgPermissionForSpace(
          SPACE_ID,
          userId,
          'org.members.manage',
        ),
      ).rejects.toMatchObject(NOT_FOUND);
    }
    await expect(
      access.requireOrgPermissionForSpace(
        OTHER_SPACE,
        ADMIN,
        'org.members.manage',
      ),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      access.requireOrgPermissionForSpace('nope', ADMIN, 'org.members.manage'),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('a space member without the org permission gets 403 (they already know the space)', async () => {
    await expect(
      access.requireOrgPermissionForSpace(
        SPACE_ID,
        MANAGER,
        'org.members.manage',
      ),
    ).rejects.toMatchObject(DENIED);
  });

  it('a space member who is also org admin passes', async () => {
    kit.orgMembers.get(ORG_ID)!.set(MANAGER, 'org_admin');
    await expect(
      access.requireOrgPermissionForSpace(
        SPACE_ID,
        MANAGER,
        'org.members.manage',
      ),
    ).resolves.toMatchObject({ id: SPACE_ID });
  });

  it('lockWithOrgPermission locks after the pre-check and re-checks the permission under the lock', async () => {
    const space = await access.lockWithOrgPermission(
      SPACE_ID,
      ADMIN,
      'org.members.manage',
    );
    expect(space.id).toBe(SPACE_ID);
    const lock = kit.trace.indexOf('spaces.lockForUpdate@out');
    expect(
      kit.trace.indexOf('orgAccess.hasPermission@out', lock),
    ).toBeGreaterThan(lock);
    // permission lost while waiting for the lock
    m.orgAccess.hasPermission
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(
      access.lockWithOrgPermission(SPACE_ID, ADMIN, 'org.members.manage'),
    ).rejects.toMatchObject(DENIED);
    m.spaces.lockForUpdate.mockResolvedValueOnce(null);
    await expect(
      access.lockWithOrgPermission(SPACE_ID, ADMIN, 'org.members.manage'),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('a non-admin never takes the lock', async () => {
    await expect(
      access.lockWithOrgPermission(SPACE_ID, OUTSIDER, 'org.members.manage'),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(m.spaces.lockForUpdate).not.toHaveBeenCalled();
  });
});

describe('RecoveryKit', () => {
  const rk = kit.deps.recoveryKit;

  it('currentFingerprint: the fingerprint of the org key, or null without a kit', async () => {
    await expect(rk.currentFingerprint(ORG_ID)).resolves.toBe(fp(KIT_PK));
    await expect(rk.currentFingerprint(OTHER_ORG)).resolves.toBeNull();
  });

  it('assertCurrent returns the fingerprint computed from the ORGANIZATION key', async () => {
    await expect(rk.assertCurrent(ORG_ID, KIT_PK)).resolves.toBe(fp(KIT_PK));
    expect(m.fingerprinter.fingerprint).toHaveBeenCalledWith(KIT_PK);
  });

  it('no kit: 422 recovery-key-required; another key: 409 recovery-key-changed; malformed: 422', async () => {
    await expect(rk.assertCurrent(OTHER_ORG, KIT_PK)).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'recovery-key-required',
    });
    const err = await rk
      .assertCurrent(ORG_ID, OLD_KIT_PK)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      constructor: ConflictError,
      code: 'recovery-key-changed',
    });
    expect(String((err as Error).message)).not.toContain(OLD_KIT_PK);
    await expect(rk.assertCurrent(ORG_ID, 'short')).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'recovery-public-key-invalid',
    });
  });

  it('isRewrapRequired: true when any version has another fingerprint; false without a kit', async () => {
    const v = (f: string) => ({
      id: 'k',
      spaceId: SPACE_ID,
      version: 1,
      recoveryWrappedKey: 'x',
      recoveryKeyFingerprint: f,
    });
    await expect(rk.isRewrapRequired(ORG_ID, [v(fp(KIT_PK))])).resolves.toBe(
      false,
    );
    await expect(
      rk.isRewrapRequired(ORG_ID, [v(fp(KIT_PK)), v(fp(OLD_KIT_PK))]),
    ).resolves.toBe(true);
    await expect(
      rk.isRewrapRequired(OTHER_ORG, [v(fp(OLD_KIT_PK))]),
    ).resolves.toBe(false);
  });
});
