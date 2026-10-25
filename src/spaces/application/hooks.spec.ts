import {
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import {
  ADMIN,
  EDITOR,
  INVITATION_ID,
  MANAGER,
  NOW,
  ORG_ID,
  OTHER_SPACE,
  OUTSIDER,
  READER,
  SPACE_ID,
  makeSpaceKit,
} from '../../../test/support/spaces-kit.js';
import { SpacesInvitationHook } from './invitation.hook.js';
import { SpacesMemberRemovedHook } from './member-removed.hook.js';

const kit = makeSpaceKit();
const d = kit.deps;
const m = kit.mocks;
const SPACE_2 = '019a1b2c-0000-7000-8000-0000000005a2';
const SPACE_3 = '019a1b2c-0000-7000-8000-0000000005a3';

beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
});

describe('SpacesMemberRemovedHook', () => {
  const hook = () =>
    new SpacesMemberRemovedHook(
      d.memberRemovedHooks,
      d.spaces,
      d.roles,
      d.grants,
      d.pending,
      d.audit,
    );
  const ctx = {
    organizationId: ORG_ID,
    userId: READER,
    actorId: ADMIN,
    reason: 'removed' as const,
    now: NOW,
  };

  it('registers on init and unregisters on destroy', () => {
    const h = hook();
    h.onModuleInit();
    expect(m.memberRemovedHooks.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'spaces.member-removed' }),
    );
    h.onModuleDestroy();
    expect(m.memberRemovedHooks.unregister).toHaveBeenCalledWith(
      'spaces.member-removed',
    );
  });

  it('locks the spaces first, tombstones copies and roles, flags rotation, cancels pendings, audits', async () => {
    kit.addSpace(SPACE_2, ORG_ID, [
      [READER, 'space_manager'],
      [EDITOR, 'space_reader'],
    ]);
    kit.addSpace(SPACE_3, ORG_ID, [[MANAGER, 'space_manager']]);
    await hook().onMemberRemoved(ctx);
    // the spaces are locked (sorted) before any tombstone
    const firstLock = kit.trace.indexOf('spaces.lockForUpdate@out');
    expect(firstLock).toBeGreaterThan(-1);
    expect(kit.trace.indexOf('grants.tombstoneUserInOrg@out')).toBeGreaterThan(
      firstLock,
    );
    expect(
      m.spaces.lockForUpdate.mock.calls.map((c) => c[1] as string),
    ).toEqual([SPACE_ID, SPACE_2].sort());
    expect(m.grants.tombstoneUserInOrg).toHaveBeenCalledWith(ORG_ID, READER);
    expect(m.roles.removeUserInOrg).toHaveBeenCalledWith(ORG_ID, READER);
    expect(m.pending.cancelForUser).toHaveBeenCalledWith(ORG_ID, READER);
    expect(kit.spacesById.get(SPACE_ID)!.keyRotationRequired).toBe(true);
    expect(kit.spacesById.get(SPACE_2)!.keyRotationRequired).toBe(true);
    expect(kit.spacesById.get(SPACE_3)!.keyRotationRequired).toBe(false);
    // SPACE_2 is left without a manager: allowed
    expect([...kit.spaceRoles.get(SPACE_2)!.keys()]).toEqual([EDITOR]);
    expect(kit.audited()).toEqual(
      [SPACE_ID, SPACE_2].sort().map((spaceId) => ({
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'space.member_removed',
        metadata: {
          spaceId,
          targetUserId: READER,
          reason: 'organization_removed',
        },
      })),
    );
  });

  it('a space only reached by a copy (a concurrent rotation) is locked and flagged too', async () => {
    m.grants.tombstoneUserInOrg.mockResolvedValue([SPACE_ID, SPACE_2]);
    kit.addSpace(SPACE_2, ORG_ID, [[MANAGER, 'space_manager']]);
    await hook().onMemberRemoved({ ...ctx, reason: 'left', actorId: READER });
    expect(kit.spacesById.get(SPACE_2)!.keyRotationRequired).toBe(true);
    expect(kit.audited().map((a) => a.metadata?.reason)).toEqual([
      'organization_left',
      'organization_left',
    ]);
  });

  it('no spaces: nothing locked, only the pending grants cancelled', async () => {
    await hook().onMemberRemoved({ ...ctx, userId: OUTSIDER });
    expect(m.spaces.lockForUpdate).not.toHaveBeenCalled();
    expect(m.spaces.save).not.toHaveBeenCalled();
    expect(m.pending.cancelForUser).toHaveBeenCalledWith(ORG_ID, OUTSIDER);
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  it('an error propagates (the organization rolls the removal back)', async () => {
    m.grants.tombstoneUserInOrg.mockRejectedValue(new Error('db down'));
    await expect(hook().onMemberRemoved(ctx)).rejects.toThrow('db down');
  });
});

describe('SpacesInvitationHook', () => {
  const hook = () =>
    new SpacesInvitationHook(
      d.invitationHooks,
      d.spaces,
      d.roles,
      d.intents,
      d.pending,
    );
  const created = (
    spaces: { spaceId: string; roleKey: string }[],
    actorId = MANAGER,
  ) => ({
    organizationId: ORG_ID,
    invitationId: INVITATION_ID,
    actorId,
    spaces: spaces as { spaceId: string; roleKey: 'space_reader' }[],
  });
  const accepted = (userId = OUTSIDER) => ({
    organizationId: ORG_ID,
    invitationId: INVITATION_ID,
    userId,
    now: NOW,
  });

  it('registers on init and unregisters on destroy', () => {
    const h = hook();
    h.onModuleInit();
    expect(m.invitationHooks.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'spaces.invitation' }),
    );
    h.onModuleDestroy();
    expect(m.invitationHooks.unregister).toHaveBeenCalledWith(
      'spaces.invitation',
    );
  });

  it('validateAndRecord: the space manager records the intents', async () => {
    await hook().validateAndRecord(
      created([{ spaceId: SPACE_ID, roleKey: 'space_editor' }]),
    );
    expect(m.intents.record).toHaveBeenCalledWith(ORG_ID, INVITATION_ID, [
      { spaceId: SPACE_ID, roleKey: 'space_editor' },
    ]);
  });

  it('validateAndRecord: a space of another organization or malformed id -> 404; nothing recorded', async () => {
    for (const spaceId of [OTHER_SPACE, 'nope']) {
      await expect(
        hook().validateAndRecord(
          created([{ spaceId, roleKey: 'space_reader' }]),
        ),
      ).rejects.toMatchObject({
        constructor: NotFoundError,
        code: 'space-not-found',
      });
    }
    expect(m.intents.record).not.toHaveBeenCalled();
  });

  it('validateAndRecord: an admin or editor who is not manager of the space -> 403', async () => {
    for (const actorId of [ADMIN, EDITOR]) {
      await expect(
        hook().validateAndRecord(
          created([{ spaceId: SPACE_ID, roleKey: 'space_reader' }], actorId),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    expect(m.intents.record).not.toHaveBeenCalled();
  });

  it('validateAndRecord: invalid role -> 422', async () => {
    await expect(
      hook().validateAndRecord(
        created([{ spaceId: SPACE_ID, roleKey: 'org_admin' }]),
      ),
    ).rejects.toBeInstanceOf(DomainValidationError);
  });

  it('onAccepted: creates a pending grant per intent (requested_by unknown -> null)', async () => {
    m.intents.forInvitation.mockResolvedValue([
      { spaceId: SPACE_ID, roleKey: 'space_editor' },
    ]);
    await hook().onAccepted(accepted());
    expect(m.intents.forInvitation).toHaveBeenCalledWith(ORG_ID, INVITATION_ID);
    expect(m.pending.create).toHaveBeenCalledWith(ORG_ID, {
      id: expect.any(String) as string,
      spaceId: SPACE_ID,
      userId: OUTSIDER,
      roleKey: 'space_editor',
      invitationId: INVITATION_ID,
      requestedByUserId: null,
    });
  });

  it('onAccepted: skips spaces the user is already in, spaces with a pending grant and vanished spaces', async () => {
    m.intents.forInvitation.mockResolvedValue([
      { spaceId: SPACE_ID, roleKey: 'space_editor' },
      { spaceId: SPACE_2, roleKey: 'space_reader' },
      { spaceId: SPACE_3, roleKey: 'space_reader' },
    ]);
    kit.addSpace(SPACE_2, ORG_ID, [[MANAGER, 'space_manager']]);
    m.pending.findPending.mockImplementation(
      async (_o: string, spaceId: string) =>
        spaceId === SPACE_2 ? { id: 'p' } : null,
    );
    // READER is already in SPACE_ID; SPACE_3 does not exist
    await hook().onAccepted(accepted(READER));
    expect(m.pending.create).not.toHaveBeenCalled();
  });

  it('onAccepted: no intents -> nothing', async () => {
    await hook().onAccepted(accepted());
    expect(m.pending.create).not.toHaveBeenCalled();
  });
});
