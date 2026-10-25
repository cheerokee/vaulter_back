import {
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import {
  ADMIN,
  MEMBER,
  ORG_ID,
  STRANGER,
  makeKit,
} from '../../../test/support/organizations-kit.js';

const kit = makeKit();
const { access } = kit.deps;

beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
});

describe('OrganizationAccess', () => {
  it('requireMember returns the membership of a member', async () => {
    await expect(access.requireMember(ORG_ID, MEMBER)).resolves.toMatchObject({
      userId: MEMBER,
      roleKey: 'org_member',
    });
  });

  it('requireMember: a non-member gets 404 organization-not-found', async () => {
    const err = await access.requireMember(ORG_ID, STRANGER).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('organization-not-found');
  });

  it('requireMember: a nonexistent or malformed id also reads as not found, without hitting the database', async () => {
    await expect(
      access.requireMember('019a1b2c-0000-7000-8000-00000000ffff', ADMIN),
    ).rejects.toMatchObject({ code: 'organization-not-found' });
    kit.mocks.memberships.find.mockClear();
    await expect(
      access.requireMember('not-a-uuid', ADMIN),
    ).rejects.toMatchObject({ code: 'organization-not-found' });
    expect(kit.mocks.memberships.find).not.toHaveBeenCalled();
  });

  it('requirePermission: the admin has org.members.manage', async () => {
    await expect(
      access.requirePermission(ORG_ID, ADMIN, 'org.members.manage'),
    ).resolves.toMatchObject({ userId: ADMIN, roleKey: 'org_admin' });
  });

  it('requirePermission: a member without the permission gets 403 permission-denied', async () => {
    const err = await access
      .requirePermission(ORG_ID, MEMBER, 'org.members.manage')
      .catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(err.code).toBe('permission-denied');
  });

  it('requirePermission: a non-member gets 404 before any permission lookup', async () => {
    await expect(
      access.requirePermission(ORG_ID, STRANGER, 'org.members.manage'),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(kit.mocks.roles.permissionsOf).not.toHaveBeenCalled();
  });
});
