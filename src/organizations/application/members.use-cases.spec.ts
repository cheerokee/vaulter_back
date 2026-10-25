import {
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import {
  ADMIN,
  MEMBER,
  NOW,
  ORG_ID,
  STRANGER,
  actor,
  makeKit,
  makeOrganization,
} from '../../../test/support/organizations-kit.js';
import { ChangeMemberRoleUseCase } from './change-member-role.use-case.js';
import { LeaveOrganizationUseCase } from './leave-organization.use-case.js';
import { ListMembersUseCase } from './list-members.use-case.js';
import { RemoveMemberUseCase } from './remove-member.use-case.js';

const kit = makeKit();
const d = kit.deps;
const m = kit.mocks;
const ADMIN2 = '019a1b2c-0000-7000-8000-0000000000a2';

beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

/** lockOrgAdmins must come first inside the unit of work, before the membership rules read anything. */
function expectLockFirst(): void {
  expect(kit.trace[0]).toBe('roles.lockOrgAdmins');
  expect(kit.trace.every((t) => !t.endsWith('@out'))).toBe(true);
}

describe('ListMembersUseCase', () => {
  const useCase = () =>
    new ListMembersUseCase(d.access, d.memberships, d.directory);

  it('joins the members with the user directory', async () => {
    m.memberships.list.mockResolvedValue({
      items: [
        {
          organizationId: ORG_ID,
          userId: ADMIN,
          roleKey: 'org_admin',
          joinedAt: NOW,
        },
        {
          organizationId: ORG_ID,
          userId: MEMBER,
          roleKey: 'org_member',
          joinedAt: NOW,
        },
      ],
      nextCursor: 'n',
    });
    const page = { limit: 2 };
    const out = await useCase().execute(actor(MEMBER), ORG_ID, page);
    expect(m.memberships.list).toHaveBeenCalledWith(ORG_ID, page);
    expect(m.directory.findPublicByIds).toHaveBeenCalledWith([ADMIN, MEMBER]);
    expect(out).toEqual({
      items: [
        {
          userId: ADMIN,
          name: 'name-a1',
          email: 'a1@x.com',
          publicKey: 'pk-a1',
          roleKey: 'org_admin',
          joinedAt: NOW,
        },
        {
          userId: MEMBER,
          name: 'name-b1',
          email: 'b1@x.com',
          publicKey: 'pk-b1',
          roleKey: 'org_member',
          joinedAt: NOW,
        },
      ],
      nextCursor: 'n',
    });
  });

  it('404 for a non-member', async () => {
    await expect(
      useCase().execute(actor(STRANGER), ORG_ID, { limit: 10 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(m.memberships.list).not.toHaveBeenCalled();
  });
});

describe('ChangeMemberRoleUseCase', () => {
  const useCase = () =>
    new ChangeMemberRoleUseCase(
      d.access,
      d.orgs,
      d.memberships,
      d.roles,
      d.audit,
      d.uow,
    );

  it('promotes a member to admin, locking the admins first, and audits', async () => {
    const out = await useCase().execute(
      actor(ADMIN),
      ORG_ID,
      MEMBER,
      'org_admin',
    );
    expectLockFirst();
    expect(m.roles.assignOrgRole).toHaveBeenCalledWith(
      ORG_ID,
      MEMBER,
      'org_admin',
      ADMIN,
    );
    expect(out).toEqual({ userId: MEMBER, roleKey: 'org_admin' });
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'member.role_changed',
        metadata: { targetUserId: MEMBER, from: 'org_member', to: 'org_admin' },
      },
    ]);
  });

  it('refuses to demote the last admin (even themselves)', async () => {
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, ADMIN, 'org_member'),
    ).rejects.toMatchObject({ code: 'last-admin' });
    expectLockFirst();
    expect(m.roles.assignOrgRole).not.toHaveBeenCalled();
    expect(m.auditRepo.append).not.toHaveBeenCalled();
  });

  it('demotes an admin when another one remains', async () => {
    kit.members.set(ADMIN2, 'org_admin');
    await useCase().execute(actor(ADMIN), ORG_ID, ADMIN2, 'org_member');
    expect(m.roles.assignOrgRole).toHaveBeenCalledWith(
      ORG_ID,
      ADMIN2,
      'org_member',
      ADMIN,
    );
  });

  it('refuses to demote the owner of a personal organization', async () => {
    kit.setOrganization(
      makeOrganization({ isPersonal: true, personalOwnerUserId: ADMIN }),
    );
    kit.members.set(ADMIN2, 'org_admin');
    await expect(
      useCase().execute(actor(ADMIN2), ORG_ID, ADMIN, 'org_member'),
    ).rejects.toMatchObject({ code: 'personal-owner-protected' });
  });

  it('only accepts org_admin or org_member, before touching the database', async () => {
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, MEMBER, 'space_reader'),
    ).rejects.toBeInstanceOf(DomainValidationError);
    expect(m.uow.run).not.toHaveBeenCalled();
  });

  it('same role is a no-op without audit', async () => {
    const out = await useCase().execute(
      actor(ADMIN),
      ORG_ID,
      MEMBER,
      'org_member',
    );
    expect(out).toEqual({ userId: MEMBER, roleKey: 'org_member' });
    expect(m.roles.assignOrgRole).not.toHaveBeenCalled();
    expect(m.auditRepo.append).not.toHaveBeenCalled();
  });

  it('404 member-not-found for a target outside the organization', async () => {
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, STRANGER, 'org_admin'),
    ).rejects.toMatchObject({ code: 'member-not-found' });
  });

  it('403 for a member, 404 for a non-member', async () => {
    await expect(
      useCase().execute(actor(MEMBER), ORG_ID, ADMIN, 'org_member'),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      useCase().execute(actor(STRANGER), ORG_ID, ADMIN, 'org_member'),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(m.roles.assignOrgRole).not.toHaveBeenCalled();
  });
});

describe('RemoveMemberUseCase', () => {
  const useCase = () =>
    new RemoveMemberUseCase(
      d.access,
      d.orgs,
      d.memberships,
      d.roles,
      d.audit,
      d.uow,
    );

  it('removes a member (tombstone) and audits member.removed', async () => {
    await useCase().execute(actor(ADMIN), ORG_ID, MEMBER);
    expectLockFirst();
    expect(m.memberships.remove).toHaveBeenCalledWith(ORG_ID, MEMBER);
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'member.removed',
        metadata: { targetUserId: MEMBER },
      },
    ]);
  });

  it('refuses to remove the last admin', async () => {
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, ADMIN),
    ).rejects.toMatchObject({ code: 'last-admin' });
    expect(m.memberships.remove).not.toHaveBeenCalled();
  });

  it('refuses to remove the personal owner even with other admins', async () => {
    kit.setOrganization(
      makeOrganization({ isPersonal: true, personalOwnerUserId: ADMIN }),
    );
    kit.members.set(ADMIN2, 'org_admin');
    await expect(
      useCase().execute(actor(ADMIN2), ORG_ID, ADMIN),
    ).rejects.toMatchObject({ code: 'personal-owner-protected' });
  });

  it('403 for a member, 404 for a non-member, 404 member-not-found for an unknown target', async () => {
    await expect(
      useCase().execute(actor(MEMBER), ORG_ID, ADMIN),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      useCase().execute(actor(STRANGER), ORG_ID, MEMBER),
    ).rejects.toMatchObject({ code: 'organization-not-found' });
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, STRANGER),
    ).rejects.toMatchObject({ code: 'member-not-found' });
    expect(m.memberships.remove).not.toHaveBeenCalled();
  });
});

describe('LeaveOrganizationUseCase', () => {
  const useCase = () =>
    new LeaveOrganizationUseCase(
      d.access,
      d.orgs,
      d.memberships,
      d.roles,
      d.audit,
      d.uow,
    );

  it('a member leaves and member.left is audited', async () => {
    await useCase().execute(actor(MEMBER), ORG_ID);
    expectLockFirst();
    expect(m.memberships.remove).toHaveBeenCalledWith(ORG_ID, MEMBER);
    expect(kit.audited()).toEqual([
      { organizationId: ORG_ID, userId: MEMBER, action: 'member.left' },
    ]);
  });

  it('the last admin cannot leave', async () => {
    await expect(useCase().execute(actor(ADMIN), ORG_ID)).rejects.toMatchObject(
      { code: 'last-admin' },
    );
    expect(m.memberships.remove).not.toHaveBeenCalled();
  });

  it('the owner cannot leave the personal organization', async () => {
    kit.setOrganization(
      makeOrganization({ isPersonal: true, personalOwnerUserId: ADMIN }),
    );
    kit.members.set(ADMIN2, 'org_admin');
    await expect(useCase().execute(actor(ADMIN), ORG_ID)).rejects.toMatchObject(
      { code: 'cannot-leave-personal' },
    );
  });

  it('404 for a non-member', async () => {
    await expect(
      useCase().execute(actor(STRANGER), ORG_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(m.memberships.remove).not.toHaveBeenCalled();
  });
});
