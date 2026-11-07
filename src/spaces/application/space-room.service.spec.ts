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
  HUB_ID,
  KIT_PK,
  MANAGER,
  OLD_KIT_PK,
  ORG_ID,
  OTHER_HUB,
  OTHER_ORG,
  READER,
  SPACE_ID,
  actor,
  makeSpaceKit,
  wk,
} from '../../../test/support/spaces-kit.js';
import { SPACE_MAX_MEMBERS } from '../domain/space-membership.js';
import { SpaceRoomService, type GrantRoomInput } from './space-room.service.js';

const kit = makeSpaceKit();
const d = kit.deps;
const m = kit.mocks;
const SPACE_2 = '019a1b2c-0000-7000-8000-0000000005a2';
const SPACE_3 = '019a1b2c-0000-7000-8000-0000000005a3';
const kId = (space: string, v: number) => `${space.slice(-3)}-k${v}`;

beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
});

const service = () =>
  new SpaceRoomService(
    d.access,
    d.recoveryKit,
    d.directory,
    d.spaces,
    d.keys,
    d.roles,
    d.room,
    d.audit,
    d.uow,
  );

describe('SpaceRoomService.grantRoom', () => {
  const confirmHubLink = vi.fn<(orgId: string) => Promise<void>>();
  const input = (over: Partial<GrantRoomInput> = {}): GrantRoomInput => ({
    hubId: HUB_ID,
    spaceId: SPACE_ID,
    roleKey: 'space_reader',
    recoveryPublicKey: KIT_PK,
    grants: [
      { version: 1, wrappedKey: wk(41) },
      { version: 2, wrappedKey: wk(42) },
    ],
    confirmHubLink,
    ...over,
  });
  beforeEach(() => {
    confirmHubLink.mockImplementation(async () => {
      kit.trace.push('confirmHubLink');
    });
    kit.addSpace(
      SPACE_ID,
      ORG_ID,
      [
        [MANAGER, 'space_manager'],
        [EDITOR, 'space_editor'],
        [READER, 'space_reader'],
      ],
      { version: 2 },
    );
  });

  it('the manager opens the space in the Room: copies of every version for the hub, the Room role, audited', async () => {
    await expect(service().grantRoom(actor(MANAGER), input())).resolves.toEqual(
      {
        hubId: HUB_ID,
        spaceId: SPACE_ID,
        roleKey: 'space_reader',
      },
    );
    expect(m.room.upsertHubGrant.mock.calls).toEqual([
      [ORG_ID, kId(SPACE_ID, 1), HUB_ID, wk(41)],
      [ORG_ID, kId(SPACE_ID, 2), HUB_ID, wk(42)],
    ]);
    expect(m.room.assignRoom).toHaveBeenCalledWith(
      ORG_ID,
      SPACE_ID,
      HUB_ID,
      'space_reader',
      MANAGER,
    );
    // the hub link is confirmed with the space's organization BEFORE the space lock; writes after it
    expect(confirmHubLink).toHaveBeenCalledWith(ORG_ID);
    const lock = kit.trace.indexOf('spaces.lockForUpdate');
    expect(kit.trace.indexOf('confirmHubLink')).toBeLessThan(lock);
    expect(kit.trace.indexOf('room.upsertHubGrant')).toBeGreaterThan(lock);
    expect(
      kit.trace.every((t) => !t.endsWith('@out') || t === 'confirmHubLink'),
    ).toBe(true);
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: MANAGER,
        action: 'hub.room.granted',
        metadata: { spaceId: SPACE_ID, hubId: HUB_ID, roleKey: 'space_reader' },
      },
    ]);
    // no sealed copy in the audit
    expect(kit.auditDump()).not.toContain(wk(41));
  });

  it('defaults the Room role to space_reader and accepts space_editor; space_manager is 422', async () => {
    await service().grantRoom(actor(MANAGER), input({ roleKey: undefined }));
    expect(kit.roomBySpace.get(SPACE_ID)!.get(HUB_ID)).toBe('space_reader');
    await service().grantRoom(
      actor(MANAGER),
      input({ hubId: OTHER_HUB, roleKey: 'space_editor' }),
    );
    expect(kit.roomBySpace.get(SPACE_ID)!.get(OTHER_HUB)).toBe('space_editor');
    m.uow.run.mockClear();
    await expect(
      service().grantRoom(actor(MANAGER), input({ roleKey: 'space_manager' })),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'role-invalid',
    });
    expect(m.uow.run).not.toHaveBeenCalled();
  });

  it('only a space manager: editor 403, org admin outside the space 404, nothing written', async () => {
    await expect(
      service().grantRoom(actor(EDITOR), input()),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      service().grantRoom(actor(ADMIN), input()),
    ).rejects.toMatchObject({
      constructor: NotFoundError,
      code: 'space-not-found',
    });
    expect(m.room.upsertHubGrant).not.toHaveBeenCalled();
    expect(m.room.assignRoom).not.toHaveBeenCalled();
    expect(confirmHubLink).not.toHaveBeenCalled();
  });

  it('copies must cover every version (409 key-versions-mismatch)', async () => {
    for (const grants of [
      [{ version: 1, wrappedKey: wk(41) }],
      [
        { version: 1, wrappedKey: wk(41) },
        { version: 2, wrappedKey: wk(42) },
        { version: 3, wrappedKey: wk(43) },
      ],
    ]) {
      await expect(
        service().grantRoom(actor(MANAGER), input({ grants })),
      ).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'key-versions-mismatch',
      });
    }
    expect(m.room.upsertHubGrant).not.toHaveBeenCalled();
  });

  it('the kit must be the current one (409 recovery-key-changed); a bad wrapped key is 422 before the unit of work', async () => {
    await expect(
      service().grantRoom(
        actor(MANAGER),
        input({ recoveryPublicKey: OLD_KIT_PK }),
      ),
    ).rejects.toMatchObject({ code: 'recovery-key-changed' });
    m.uow.run.mockClear();
    await expect(
      service().grantRoom(
        actor(MANAGER),
        input({ grants: [{ version: 1, wrappedKey: BAD_WK }] }),
      ),
    ).rejects.toMatchObject({ code: 'wrapped-key-invalid' });
    expect(m.uow.run).not.toHaveBeenCalled();
    expect(m.room.assignRoom).not.toHaveBeenCalled();
  });

  it('a refused hub link (the caller throws) stops before the space lock', async () => {
    confirmHubLink.mockRejectedValue(
      new NotFoundError('hub-not-found', 'The hub was not found.'),
    );
    await expect(
      service().grantRoom(actor(MANAGER), input()),
    ).rejects.toMatchObject({ code: 'hub-not-found' });
    expect(m.spaces.lockForUpdate).not.toHaveBeenCalled();
    expect(m.room.assignRoom).not.toHaveBeenCalled();
  });

  it('the organization policy must allow NEW room grants (422 room-not-allowed)', async () => {
    kit.roomPolicy.set(ORG_ID, false);
    await expect(
      service().grantRoom(actor(MANAGER), input()),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'room-not-allowed',
    });
    expect(m.room.assignRoom).not.toHaveBeenCalled();
    expect(m.room.upsertHubGrant).not.toHaveBeenCalled();
  });

  it('policy off: a hub ALREADY in the Room may be granted again or change role (not a new grant)', async () => {
    kit.roomPolicy.set(ORG_ID, false);
    kit.roomBySpace.get(SPACE_ID)!.set(HUB_ID, 'space_reader');
    await expect(
      service().grantRoom(actor(MANAGER), input({ roleKey: 'space_editor' })),
    ).resolves.toMatchObject({ roleKey: 'space_editor' });
    expect(kit.roomBySpace.get(SPACE_ID)!.get(HUB_ID)).toBe('space_editor');
    // another hub is still a new grant: refused
    await expect(
      service().grantRoom(actor(MANAGER), input({ hubId: OTHER_HUB })),
    ).rejects.toMatchObject({ code: 'room-not-allowed' });
  });

  it('SPACE_MAX_MEMBERS counts people and Room hubs together (409 space-member-limit); a re-grant does not count twice', async () => {
    const room = kit.roomBySpace.get(SPACE_ID)!;
    // 3 people; fill the rest of the seats with Room hubs
    for (let i = 3; i < SPACE_MAX_MEMBERS; i++)
      room.set(`hub-${i}`, 'space_reader');
    await expect(
      service().grantRoom(actor(MANAGER), input()),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'space-member-limit',
    });
    expect(m.room.assignRoom).not.toHaveBeenCalled();
    // a hub already in the Room may be granted again (new role / copies), even at the limit
    room.delete(`hub-${SPACE_MAX_MEMBERS - 1}`);
    room.set(HUB_ID, 'space_reader');
    await expect(
      service().grantRoom(actor(MANAGER), input({ roleKey: 'space_editor' })),
    ).resolves.toMatchObject({ roleKey: 'space_editor' });
  });

  it('a malformed hub id is 404 hub-not-found without touching the database', async () => {
    await expect(
      service().grantRoom(actor(MANAGER), input({ hubId: 'nope' })),
    ).rejects.toMatchObject({ code: 'hub-not-found' });
    expect(m.uow.run).not.toHaveBeenCalled();
  });
});

describe('SpaceRoomService.revokeRoom', () => {
  beforeEach(() => {
    kit.roomBySpace.get(SPACE_ID)!.set(HUB_ID, 'space_reader');
  });

  it('a space manager takes the space out of the Room: tombstones, rotation pending, audited', async () => {
    await expect(
      service().revokeRoom(
        { kind: 'space_manager', userId: MANAGER },
        { hubId: HUB_ID, spaceId: SPACE_ID, reason: 'revoked' },
      ),
    ).resolves.toBe(true);
    expect(m.room.removeRoom).toHaveBeenCalledWith(ORG_ID, SPACE_ID, HUB_ID);
    expect(kit.spacesById.get(SPACE_ID)!.keyRotationRequired).toBe(true);
    expect(kit.trace.indexOf('room.removeRoom')).toBeGreaterThan(
      kit.trace.indexOf('spaces.lockForUpdate'),
    );
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: MANAGER,
        action: 'hub.room.revoked',
        metadata: { spaceId: SPACE_ID, hubId: HUB_ID, reason: 'revoked' },
      },
    ]);
  });

  it('a space manager: hub not in the Room is 404 room-not-found; editor 403; admin outside 404', async () => {
    await expect(
      service().revokeRoom(
        { kind: 'space_manager', userId: MANAGER },
        { hubId: OTHER_HUB, spaceId: SPACE_ID, reason: 'revoked' },
      ),
    ).rejects.toMatchObject({
      constructor: NotFoundError,
      code: 'room-not-found',
    });
    await expect(
      service().revokeRoom(
        { kind: 'space_manager', userId: EDITOR },
        { hubId: HUB_ID, spaceId: SPACE_ID, reason: 'revoked' },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      service().revokeRoom(
        { kind: 'space_manager', userId: ADMIN },
        { hubId: HUB_ID, spaceId: SPACE_ID, reason: 'revoked' },
      ),
    ).rejects.toMatchObject({ code: 'space-not-found' });
    expect(kit.spacesById.get(SPACE_ID)!.keyRotationRequired).toBe(false);
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  it('trusted (the caller authorized it, e.g. the hub owner or a hook): no space role needed', async () => {
    await expect(
      service().revokeRoom(
        { kind: 'trusted', organizationId: ORG_ID, actorId: ADMIN },
        { hubId: HUB_ID, spaceId: SPACE_ID, reason: 'owner_left_space' },
      ),
    ).resolves.toBe(true);
    expect(kit.spacesById.get(SPACE_ID)!.keyRotationRequired).toBe(true);
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'hub.room.revoked',
        metadata: {
          spaceId: SPACE_ID,
          hubId: HUB_ID,
          reason: 'owner_left_space',
        },
      },
    ]);
  });

  it('trusted: nothing in the Room, another organization or malformed ids -> false, no write', async () => {
    const svc = service();
    const revoker = {
      kind: 'trusted' as const,
      organizationId: ORG_ID,
      actorId: null,
    };
    await expect(
      svc.revokeRoom(revoker, {
        hubId: OTHER_HUB,
        spaceId: SPACE_ID,
        reason: 'revoked',
      }),
    ).resolves.toBe(false);
    await expect(
      svc.revokeRoom(
        { ...revoker, organizationId: OTHER_ORG },
        { hubId: HUB_ID, spaceId: SPACE_ID, reason: 'revoked' },
      ),
    ).resolves.toBe(false);
    await expect(
      svc.revokeRoom(revoker, {
        hubId: 'nope',
        spaceId: SPACE_ID,
        reason: 'revoked',
      }),
    ).resolves.toBe(false);
    expect(m.spaces.save).not.toHaveBeenCalled();
    expect(m.audit.record).not.toHaveBeenCalled();
  });
});

describe('SpaceRoomService bulk revocations', () => {
  beforeEach(() => {
    kit.addSpace(SPACE_2, ORG_ID, [[MANAGER, 'space_manager']]);
    kit.addSpace(SPACE_3, ORG_ID, [[MANAGER, 'space_manager']]);
    kit.roomBySpace.get(SPACE_ID)!.set(HUB_ID, 'space_reader');
    kit.roomBySpace.get(SPACE_2)!.set(HUB_ID, 'space_editor');
    kit.roomBySpace.get(SPACE_3)!.set(OTHER_HUB, 'space_reader');
  });

  it('revokeRoomForOrganization: locks the spaces in id order first, then tombstones, flags and audits each', async () => {
    await expect(
      service().revokeRoomForOrganization({
        hubId: HUB_ID,
        organizationId: ORG_ID,
        actorId: ADMIN,
        reason: 'hub_unlinked',
      }),
    ).resolves.toEqual([SPACE_ID, SPACE_2].sort());
    expect(m.spaces.lockForUpdate.mock.calls.map((c) => c[1])).toEqual(
      [SPACE_ID, SPACE_2].sort(),
    );
    expect(kit.trace.indexOf('room.removeHubInOrg')).toBeGreaterThan(
      kit.trace.lastIndexOf('spaces.lockForUpdate'),
    );
    expect(kit.spacesById.get(SPACE_ID)!.keyRotationRequired).toBe(true);
    expect(kit.spacesById.get(SPACE_2)!.keyRotationRequired).toBe(true);
    expect(kit.spacesById.get(SPACE_3)!.keyRotationRequired).toBe(false);
    expect(kit.roomBySpace.get(SPACE_3)!.has(OTHER_HUB)).toBe(true);
    expect(kit.audited()).toEqual(
      [SPACE_ID, SPACE_2].sort().map((spaceId) => ({
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'hub.room.revoked',
        metadata: { spaceId, hubId: HUB_ID, reason: 'hub_unlinked' },
      })),
    );
  });

  it('revokeRoomForOrganization: a space reached only by the tombstone (concurrent grant) is locked and flagged too', async () => {
    m.room.roomSpaceIdsOfHub.mockResolvedValueOnce([SPACE_ID]);
    await service().revokeRoomForOrganization({
      hubId: HUB_ID,
      organizationId: ORG_ID,
      actorId: null,
      reason: 'hub_unlinked',
    });
    expect(m.spaces.lockForUpdate.mock.calls.map((c) => c[1])).toEqual([
      SPACE_ID,
      SPACE_2,
    ]);
    expect(kit.spacesById.get(SPACE_2)!.keyRotationRequired).toBe(true);
  });

  it('revokeRoomForOrganization: nothing in the Room -> no lock, no audit', async () => {
    await expect(
      service().revokeRoomForOrganization({
        hubId: HUB_ID,
        organizationId: OTHER_ORG,
        actorId: null,
        reason: 'hub_unlinked',
      }),
    ).resolves.toEqual([]);
    expect(m.spaces.lockForUpdate).not.toHaveBeenCalled();
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  it('revokeAllRoomForHub: every given organization, in id order, inside one unit of work', async () => {
    await expect(
      service().revokeAllRoomForHub({
        hubId: HUB_ID,
        organizationIds: [OTHER_ORG, ORG_ID, ORG_ID],
        actorId: MANAGER,
        reason: 'hub_deregistered',
      }),
    ).resolves.toEqual([SPACE_ID, SPACE_2].sort());
    // each organization once, in id order (OTHER_ORG has nothing in the Room: no tombstone there)
    expect(m.room.roomSpaceIdsOfHub.mock.calls).toEqual(
      [ORG_ID, OTHER_ORG].sort().map((o) => [o, HUB_ID]),
    );
    expect(m.room.removeHubInOrg.mock.calls).toEqual([[ORG_ID, HUB_ID]]);
    expect(kit.audited().map((a) => a.metadata?.reason)).toEqual([
      'hub_deregistered',
      'hub_deregistered',
    ]);
  });

  it('revokeAllRoomForHub: auditMetadata is merged into every hub.room.revoked (it never overrides the standard keys)', async () => {
    await service().revokeAllRoomForHub({
      hubId: HUB_ID,
      organizationIds: [ORG_ID],
      actorId: null,
      reason: 'hub_deregistered',
      auditMetadata: {
        actor: 'platform',
        supportRequestId: 'sr-1',
        reason: 'overridden?',
      },
    });
    expect(kit.audited()).toEqual(
      [SPACE_ID, SPACE_2].sort().map((spaceId) => ({
        organizationId: ORG_ID,
        userId: null,
        action: 'hub.room.revoked',
        metadata: {
          actor: 'platform',
          supportRequestId: 'sr-1',
          spaceId,
          hubId: HUB_ID,
          reason: 'hub_deregistered',
        },
      })),
    );
  });

  it('an error propagates (the caller rolls everything back)', async () => {
    m.room.removeHubInOrg.mockRejectedValue(new Error('db down'));
    await expect(
      service().revokeRoomForOrganization({
        hubId: HUB_ID,
        organizationId: ORG_ID,
        actorId: null,
        reason: 'hub_unlinked',
      }),
    ).rejects.toThrow('db down');
  });
});
