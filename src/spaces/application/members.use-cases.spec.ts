import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import {
  ADMIN,
  BAD_WK,
  EDITOR,
  MANAGER,
  NOW,
  ORG_ID,
  OTHER_ADMIN,
  OUTSIDER,
  READER,
  SPACE_ID,
  STRANGER,
  actor,
  makeSpaceKit,
  wk,
} from '../../../test/support/spaces-kit.js';
import { AddSpaceMemberUseCase } from './add-space-member.use-case.js';
import { ChangeSpaceMemberRoleUseCase } from './change-space-member-role.use-case.js';
import { DeclinePendingGrantUseCase } from './decline-pending-grant.use-case.js';
import { LeaveSpaceUseCase } from './leave-space.use-case.js';
import { ListPendingGrantsUseCase } from './list-pending-grants.use-case.js';
import { ListSpaceMembersUseCase } from './list-space-members.use-case.js';
import { PromoteSpaceManagerUseCase } from './promote-space-manager.use-case.js';
import { RemoveSpaceMemberUseCase } from './remove-space-member.use-case.js';

const kit = makeSpaceKit();
const d = kit.deps;
const m = kit.mocks;
const NOT_FOUND = { constructor: NotFoundError, code: 'space-not-found' };
const LAST = { constructor: DomainValidationError, code: 'last-space-manager' };

beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
});

/** The non-locking pre-check comes first; the lock precedes every write. */
function expectLockedBeforeWrites(...writes: string[]): void {
  const lock = kit.trace.indexOf('spaces.lockForUpdate');
  expect(lock).toBeGreaterThan(0);
  for (const w of writes) expect(kit.trace.indexOf(w)).toBeGreaterThan(lock);
  expect(kit.trace.every((t) => !t.endsWith('@out'))).toBe(true);
}

describe('ListSpaceMembersUseCase', () => {
  const useCase = () => new ListSpaceMembersUseCase(d.access, d.roles, d.users);

  it('members with role and publicKey, for any member', async () => {
    const page = await useCase().execute(actor(READER), SPACE_ID, {
      limit: 10,
    });
    expect(page.items).toContainEqual({
      userId: MANAGER,
      name: 'name-d1',
      email: 'd1@x.com',
      publicKey: 'pk-d1',
      roleKey: 'space_manager',
      joinedAt: NOW,
    });
    expect(page.items).toHaveLength(3);
  });

  it('the org admin outside the space gets 404', async () => {
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, { limit: 10 }),
    ).rejects.toMatchObject(NOT_FOUND);
  });
});

describe('AddSpaceMemberUseCase', () => {
  const useCase = () =>
    new AddSpaceMemberUseCase(
      d.access,
      d.directory,
      d.keys,
      d.grants,
      d.roles,
      d.pending,
      d.audit,
      d.uow,
    );
  const input = {
    userId: OUTSIDER,
    roleKey: 'space_editor',
    grants: [{ version: 1, wrappedKey: wk(5) }],
  };

  it('the manager adds an org member with copies of every version; pending grant marked granted', async () => {
    kit.addSpace(SPACE_ID, ORG_ID, [[MANAGER, 'space_manager']], {
      version: 2,
    });
    const grants = [
      { version: 2, wrappedKey: wk(6) },
      { version: 1, wrappedKey: wk(5) },
    ];
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, { ...input, grants }),
    ).resolves.toEqual({ userId: OUTSIDER, roleKey: 'space_editor' });
    const kId = (v: number) => `${SPACE_ID.slice(-3)}-k${v}`;
    expect(m.grants.upsert).toHaveBeenCalledWith(
      ORG_ID,
      kId(1),
      OUTSIDER,
      wk(5),
    );
    expect(m.grants.upsert).toHaveBeenCalledWith(
      ORG_ID,
      kId(2),
      OUTSIDER,
      wk(6),
    );
    expect(m.roles.assign).toHaveBeenCalledWith(
      ORG_ID,
      SPACE_ID,
      OUTSIDER,
      'space_editor',
      MANAGER,
    );
    expect(m.pending.markGranted).toHaveBeenCalledWith(
      ORG_ID,
      SPACE_ID,
      OUTSIDER,
    );
    expectLockedBeforeWrites('keys.versions', 'grants.upsert', 'roles.assign');
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: MANAGER,
        action: 'space.member_added',
        metadata: {
          spaceId: SPACE_ID,
          targetUserId: OUTSIDER,
          roleKey: 'space_editor',
        },
      },
    ]);
    expect(kit.auditDump()).not.toContain(wk(5));
  });

  it('grants must cover exactly every version (409 key-versions-mismatch)', async () => {
    kit.addSpace(SPACE_ID, ORG_ID, [[MANAGER, 'space_manager']], {
      version: 2,
    });
    for (const grants of [
      [{ version: 1, wrappedKey: wk(5) }],
      [
        { version: 1, wrappedKey: wk(5) },
        { version: 1, wrappedKey: wk(5) },
      ],
      [
        { version: 1, wrappedKey: wk(5) },
        { version: 2, wrappedKey: wk(5) },
        { version: 3, wrappedKey: wk(5) },
      ],
    ]) {
      await expect(
        useCase().execute(actor(MANAGER), SPACE_ID, { ...input, grants }),
      ).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'key-versions-mismatch',
      });
    }
    expect(m.grants.upsert).not.toHaveBeenCalled();
  });

  it('the org admin outside the space cannot add anyone, not even themselves (404)', async () => {
    for (const userId of [ADMIN, OUTSIDER]) {
      await expect(
        useCase().execute(actor(ADMIN), SPACE_ID, { ...input, userId }),
      ).rejects.toMatchObject(NOT_FOUND);
    }
    expect(m.spaces.lockForUpdate).not.toHaveBeenCalled();
  });

  it('an editor gets 403', async () => {
    await expect(
      useCase().execute(actor(EDITOR), SPACE_ID, input),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('the target must be an active org member (404 member-not-found) and not already in the space (409)', async () => {
    for (const userId of [STRANGER, OTHER_ADMIN, 'nope']) {
      await expect(
        useCase().execute(actor(MANAGER), SPACE_ID, { ...input, userId }),
      ).rejects.toMatchObject({
        constructor: NotFoundError,
        code: 'member-not-found',
      });
    }
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, { ...input, userId: READER }),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'space-member-exists',
    });
    expect(m.grants.upsert).not.toHaveBeenCalled();
  });

  it('invalid role or wrapped key: 422 before the unit of work, the key never in the message', async () => {
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, {
        ...input,
        roleKey: 'org_admin',
      }),
    ).rejects.toMatchObject({ code: 'role-invalid' });
    const err = await useCase()
      .execute(actor(MANAGER), SPACE_ID, {
        ...input,
        grants: [{ version: 1, wrappedKey: BAD_WK }],
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'wrapped-key-invalid' });
    expect((err as Error).message).not.toContain(BAD_WK);
    expect(m.uow.run).not.toHaveBeenCalled();
  });
});

describe('ChangeSpaceMemberRoleUseCase', () => {
  const useCase = () =>
    new ChangeSpaceMemberRoleUseCase(d.access, d.roles, d.audit, d.uow);

  it('the manager changes a role under the space and managers lock; audited with from/to', async () => {
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, READER, 'space_editor'),
    ).resolves.toEqual({ userId: READER, roleKey: 'space_editor' });
    expectLockedBeforeWrites('roles.lockSpaceManagers', 'roles.assign');
    expect(kit.audited()[0]).toEqual({
      organizationId: ORG_ID,
      userId: MANAGER,
      action: 'space.member_role_changed',
      metadata: {
        spaceId: SPACE_ID,
        targetUserId: READER,
        from: 'space_reader',
        to: 'space_editor',
      },
    });
  });

  it('same role: no write and no audit', async () => {
    await useCase().execute(actor(MANAGER), SPACE_ID, READER, 'space_reader');
    expect(m.roles.assign).not.toHaveBeenCalled();
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  it('the last manager cannot demote themselves while others remain (422)', async () => {
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, MANAGER, 'space_editor'),
    ).rejects.toMatchObject(LAST);
  });

  it('a second manager allows the demotion', async () => {
    kit.spaceRoles.get(SPACE_ID)!.set(EDITOR, 'space_manager');
    await useCase().execute(actor(MANAGER), SPACE_ID, MANAGER, 'space_reader');
    expect(kit.spaceRoles.get(SPACE_ID)!.get(MANAGER)).toBe('space_reader');
  });

  it('target not in the space: 404 space-member-not-found; invalid role 422; editor 403; admin outside 404', async () => {
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, OUTSIDER, 'space_editor'),
    ).rejects.toMatchObject({
      constructor: NotFoundError,
      code: 'space-member-not-found',
    });
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, 'nope', 'space_editor'),
    ).rejects.toMatchObject({ code: 'space-member-not-found' });
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, READER, 'owner'),
    ).rejects.toMatchObject({ code: 'role-invalid' });
    await expect(
      useCase().execute(actor(EDITOR), SPACE_ID, READER, 'space_editor'),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, READER, 'space_editor'),
    ).rejects.toMatchObject(NOT_FOUND);
  });
});

describe('RemoveSpaceMemberUseCase', () => {
  const useCase = () =>
    new RemoveSpaceMemberUseCase(
      d.access,
      d.roles,
      d.grants,
      d.spaces,
      d.audit,
      d.uow,
    );

  it('tombstones the copies (all versions) and the role, flags the key rotation, audits', async () => {
    await useCase().execute(actor(MANAGER), SPACE_ID, READER);
    expect(m.grants.tombstoneUser).toHaveBeenCalledWith(
      ORG_ID,
      SPACE_ID,
      READER,
    );
    expect(m.roles.remove).toHaveBeenCalledWith(ORG_ID, SPACE_ID, READER);
    expect(kit.spacesById.get(SPACE_ID)!.keyRotationRequired).toBe(true);
    expectLockedBeforeWrites(
      'roles.lockSpaceManagers',
      'grants.tombstoneUser',
      'spaces.save',
    );
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: MANAGER,
        action: 'space.member_removed',
        metadata: { spaceId: SPACE_ID, targetUserId: READER },
      },
    ]);
  });

  it('the last manager cannot be removed while others remain; non-member target 404', async () => {
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, MANAGER),
    ).rejects.toMatchObject(LAST);
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, OUTSIDER),
    ).rejects.toMatchObject({
      code: 'space-member-not-found',
    });
    expect(m.roles.remove).not.toHaveBeenCalled();
  });

  it('editor 403, admin outside 404', async () => {
    await expect(
      useCase().execute(actor(EDITOR), SPACE_ID, READER),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, READER),
    ).rejects.toMatchObject(NOT_FOUND);
  });
});

describe('LeaveSpaceUseCase', () => {
  const useCase = () =>
    new LeaveSpaceUseCase(
      d.access,
      d.roles,
      d.grants,
      d.spaces,
      d.audit,
      d.uow,
    );

  it('any member leaves: copies and role tombstoned, rotation flagged, audited', async () => {
    await useCase().execute(actor(READER), SPACE_ID);
    expect(m.grants.tombstoneUser).toHaveBeenCalledWith(
      ORG_ID,
      SPACE_ID,
      READER,
    );
    expect(m.roles.remove).toHaveBeenCalledWith(ORG_ID, SPACE_ID, READER);
    expect(kit.spacesById.get(SPACE_ID)!.keyRotationRequired).toBe(true);
    expectLockedBeforeWrites('roles.lockSpaceManagers', 'roles.remove');
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: READER,
        action: 'space.member_left',
        metadata: { spaceId: SPACE_ID },
      },
    ]);
  });

  it('the last manager cannot leave while others remain, but the only member can (orphan)', async () => {
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID),
    ).rejects.toMatchObject(LAST);
    kit.addSpace(SPACE_ID, ORG_ID, [[MANAGER, 'space_manager']]);
    await useCase().execute(actor(MANAGER), SPACE_ID);
    expect(kit.spaceRoles.get(SPACE_ID)!.size).toBe(0);
  });

  it('a non-member gets 404', async () => {
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID),
    ).rejects.toMatchObject(NOT_FOUND);
  });
});

describe('PromoteSpaceManagerUseCase', () => {
  const useCase = () =>
    new PromoteSpaceManagerUseCase(d.access, d.roles, d.audit, d.uow);
  const noManager = () =>
    kit.addSpace(SPACE_ID, ORG_ID, [
      [EDITOR, 'space_editor'],
      [READER, 'space_reader'],
    ]);

  it('an org admin outside the space promotes an existing member when there is no manager', async () => {
    noManager();
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, READER),
    ).resolves.toEqual({
      userId: READER,
      roleKey: 'space_manager',
    });
    expect(m.roles.assign).toHaveBeenCalledWith(
      ORG_ID,
      SPACE_ID,
      READER,
      'space_manager',
      ADMIN,
    );
    expectLockedBeforeWrites('roles.lockSpaceManagers', 'roles.assign');
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'space.manager_promoted',
        metadata: { spaceId: SPACE_ID, targetUserId: READER },
      },
    ]);
    // the admin did not join the space
    expect(kit.spaceRoles.get(SPACE_ID)!.has(ADMIN)).toBe(false);
  });

  it('the space has a manager: 409 space-has-manager', async () => {
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, READER),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'space-has-manager',
    });
  });

  it('the admin cannot promote themselves or someone outside the space (404)', async () => {
    noManager();
    for (const target of [ADMIN, OUTSIDER, 'nope']) {
      await expect(
        useCase().execute(actor(ADMIN), SPACE_ID, target),
      ).rejects.toMatchObject({
        constructor: NotFoundError,
        code: 'space-member-not-found',
      });
    }
    expect(m.roles.assign).not.toHaveBeenCalled();
  });

  it('needs org.members.manage: space member 403, outsider / other org admin 404', async () => {
    noManager();
    await expect(
      useCase().execute(actor(EDITOR), SPACE_ID, READER),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    for (const userId of [OUTSIDER, OTHER_ADMIN]) {
      await expect(
        useCase().execute(actor(userId), SPACE_ID, READER),
      ).rejects.toMatchObject(NOT_FOUND);
    }
  });
});

describe('ListPendingGrantsUseCase', () => {
  const useCase = () =>
    new ListPendingGrantsUseCase(d.access, d.pending, d.users);

  it('the manager sees the pending grants with the user public data', async () => {
    m.pending.listPending.mockResolvedValue({
      items: [
        {
          id: 'p1',
          spaceId: SPACE_ID,
          userId: OUTSIDER,
          roleKey: 'space_reader',
          invitationId: 'inv',
          requestedByUserId: MANAGER,
          status: 'pending',
          createdAt: NOW,
        },
      ],
      nextCursor: null,
    });
    const page = await useCase().execute(actor(MANAGER), SPACE_ID, {
      limit: 10,
    });
    expect(m.pending.listPending).toHaveBeenCalledWith(ORG_ID, SPACE_ID, {
      limit: 10,
    });
    expect(page.items).toEqual([
      {
        id: 'p1',
        userId: OUTSIDER,
        name: 'name-b1',
        email: 'b1@x.com',
        publicKey: 'pk-b1',
        roleKey: 'space_reader',
        invitationId: 'inv',
        requestedByUserId: MANAGER,
        createdAt: NOW,
      },
    ]);
  });

  it('editor 403, admin outside 404', async () => {
    await expect(
      useCase().execute(actor(EDITOR), SPACE_ID, { limit: 10 }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, { limit: 10 }),
    ).rejects.toMatchObject(NOT_FOUND);
  });
});

describe('DeclinePendingGrantUseCase', () => {
  const useCase = () =>
    new DeclinePendingGrantUseCase(d.access, d.pending, d.audit, d.uow);

  it('the manager declines; audited', async () => {
    await useCase().execute(actor(MANAGER), SPACE_ID, OUTSIDER);
    expect(m.pending.decline).toHaveBeenCalledWith(ORG_ID, SPACE_ID, OUTSIDER);
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: MANAGER,
        action: 'space.pending_grant_declined',
        metadata: { spaceId: SPACE_ID, targetUserId: OUTSIDER },
      },
    ]);
  });

  it('nothing pending: 404 pending-grant-not-found, no audit; malformed id the same', async () => {
    m.pending.decline.mockResolvedValue(false);
    for (const target of [OUTSIDER, 'nope']) {
      await expect(
        useCase().execute(actor(MANAGER), SPACE_ID, target),
      ).rejects.toMatchObject({
        constructor: NotFoundError,
        code: 'pending-grant-not-found',
      });
    }
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  it('editor 403, admin outside 404', async () => {
    await expect(
      useCase().execute(actor(EDITOR), SPACE_ID, OUTSIDER),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, OUTSIDER),
    ).rejects.toMatchObject(NOT_FOUND);
  });
});
