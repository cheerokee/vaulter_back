import type { AuditLog } from '../../organizations/application/audit-log.js';
import type { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from '../../shared/domain/errors.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { SpaceAccess } from '../../spaces/application/space-access.js';
import type {
  GrantRoomInput,
  SpaceRoomService,
} from '../../spaces/application/space-room.service.js';
import { HubOrganizationLink } from '../domain/hub-organization-link.js';
import type { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import type { HubRoleRepository } from '../domain/hub-role.repository.js';
import type { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { Hub } from '../domain/hub.js';
import type { HubRepository } from '../domain/hub.repository.js';
import { AddHubSpaceUseCase } from './add-hub-space.use-case.js';
import { AssignHubRoleUseCase } from './assign-hub-role.use-case.js';
import { DeregisterHubUseCase } from './deregister-hub.use-case.js';
import { GrantRoomUseCase } from './grant-room.use-case.js';
import type { HubAccess } from './hub-access.js';
import { RemoveHubSpaceUseCase } from './remove-hub-space.use-case.js';
import { RevokeRoomUseCase } from './revoke-room.use-case.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const HUB_ID = '019a0000-0000-7000-8000-0000000000aa';
const ORG = '019a0000-0000-7000-8000-0000000000c1';
const ORG_B = '019a0000-0000-7000-8000-0000000000c2';
const PERSONAL = '019a0000-0000-7000-8000-0000000000c9';
const OWNER = '019a0000-0000-7000-8000-0000000000a1';
const GESTOR = '019a0000-0000-7000-8000-0000000000a2';
const MEMBER = '019a0000-0000-7000-8000-0000000000b1';
const SPACE = '019a0000-0000-7000-8000-0000000005a1';
const actor = (userId: string) => ({ userId, sessionId: 's1' });
const as = <T>(x: unknown) => x as T;

const makeHub = () =>
  Hub.restore(
    {
      ownerUserId: OWNER,
      name: 'Sala',
      signingPublicKey: 's',
      encryptionPublicKey: 'e',
      lastSeenAt: null,
      deletedAt: null,
    },
    HUB_ID,
  );
const approved = () =>
  HubOrganizationLink.ownerLinks({
    hubId: HUB_ID,
    organizationId: ORG,
    userId: OWNER,
    policy: 'any_member_hub',
    now: NOW,
  });
const ref = {
  hubId: HUB_ID,
  spaceId: SPACE,
  organizationId: ORG,
  addedByUserId: OWNER,
};

const calls: string[] = [];
const log =
  (name: string, value?: unknown) =>
  async (...args: unknown[]) => {
    calls.push(`${name}${args.length ? `:${String(args[0])}` : ''}`);
    return value;
  };
const access = {
  requireAccess: vi.fn(),
  requireOwner: vi.fn(),
};
const spaceAccess = {
  requireSpaceMember: vi.fn(),
  requireSpacePermission: vi.fn(),
};
const hubs = { lockForShare: vi.fn(), lockForUpdate: vi.fn(), save: vi.fn() };
const links = {
  lockForShare: vi.fn(),
  listActiveOrgIds: vi.fn(),
  listAllOrgIds: vi.fn(),
  tombstoneAllOfHub: vi.fn(),
};
const hubSpaces = {
  add: vi.fn(),
  listInOrganization: vi.fn(),
  find: vi.fn(),
  remove: vi.fn(),
  lockForShare: vi.fn(),
  removeAllOfOrganization: vi.fn(),
};
const hubRoles = { assign: vi.fn(), removeAllOfHub: vi.fn() };
const room = {
  grantRoom: vi.fn(),
  revokeRoom: vi.fn(),
  revokeAllRoomForHub: vi.fn(),
};
const directory = {
  lockActiveMember: vi.fn(),
  personalOrganizationIdOf: vi.fn(),
};
const audit = { record: vi.fn() };
let inTx = false;
const uow = {
  run: vi.fn(async (work: () => Promise<unknown>) => {
    inTx = true;
    try {
      return await work();
    } finally {
      inTx = false;
    }
  }),
  setContext: vi.fn(),
};
const owner = () => ({ hub: makeHub(), role: 'hub_owner' });
const member = () => ({ hub: makeHub(), role: 'hub_user' });
const space = { id: SPACE, organizationId: ORG };

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  access.requireAccess.mockImplementation(async (_h: string, u: string) =>
    u === OWNER ? owner() : member(),
  );
  access.requireOwner.mockImplementation(log('requireOwner', makeHub()));
  spaceAccess.requireSpaceMember.mockImplementation(
    log('requireSpaceMember', { space, roleKey: 'space_editor' }),
  );
  spaceAccess.requireSpacePermission.mockImplementation(
    log('requireSpacePermission', { space, roleKey: 'space_manager' }),
  );
  hubs.lockForShare.mockImplementation(async () => {
    calls.push(`lockHub:${String(inTx)}`);
    return makeHub();
  });
  links.lockForShare.mockImplementation(log('shareLink', approved()));
  hubSpaces.add.mockImplementation(log('addSpace'));
  hubSpaces.find.mockResolvedValue(ref);
  hubSpaces.listInOrganization.mockResolvedValue([ref]);
  hubSpaces.remove.mockImplementation(log('removeSpace', true));
  hubSpaces.lockForShare.mockImplementation(log('shareHubSpace', ref));
  room.revokeRoom.mockImplementation(log('revokeRoom', true));
  directory.personalOrganizationIdOf.mockResolvedValue(PERSONAL);
  audit.record.mockImplementation(log('audit'));
});
afterEach(() => vi.useRealTimers());

describe('AddHubSpaceUseCase', () => {
  const useCase = () =>
    new AddHubSpaceUseCase(
      as<HubAccess>(access),
      as<SpaceAccess>(spaceAccess),
      as<HubRepository>(hubs),
      as<HubOrganizationRepository>(links),
      as<HubSpaceRepository>(hubSpaces),
      as<AuditLog>(audit),
      as<UnitOfWork>(uow),
    );

  it('the owner only needs to be a space member; then hub -> link (share) -> add -> audit', async () => {
    await useCase().execute(actor(OWNER), { hubId: HUB_ID, spaceId: SPACE });
    expect(calls).toEqual([
      `requireSpaceMember:${SPACE}`,
      'lockHub:true',
      `shareLink:${HUB_ID}`,
      'addSpace:[object Object]',
      'audit:[object Object]',
    ]);
    expect(hubSpaces.add).toHaveBeenCalledWith({
      ...ref,
      addedByUserId: OWNER,
    });
  });

  it('anyone else must be the space Gestor; an org without an approved link is 422', async () => {
    await useCase().execute(actor(GESTOR), { hubId: HUB_ID, spaceId: SPACE });
    expect(spaceAccess.requireSpacePermission).toHaveBeenCalledWith(
      SPACE,
      GESTOR,
      'space.members.manage',
    );
    const pending = HubOrganizationLink.requestByOther({
      hubId: HUB_ID,
      organizationId: ORG,
      userId: MEMBER,
      policy: 'any_member_hub',
      now: NOW,
    });
    for (const l of [null, pending]) {
      links.lockForShare.mockResolvedValueOnce(l);
      await expect(
        useCase().execute(actor(OWNER), { hubId: HUB_ID, spaceId: SPACE }),
      ).rejects.toMatchObject({
        constructor: DomainValidationError,
        code: 'organization-not-linked',
      });
    }
    expect(hubSpaces.add).toHaveBeenCalledTimes(1);
  });
});

describe('RemoveHubSpaceUseCase', () => {
  const useCase = () =>
    new RemoveHubSpaceUseCase(
      as<HubAccess>(access),
      as<SpaceAccess>(spaceAccess),
      as<HubSpaceRepository>(hubSpaces),
      as<SpaceRoomService>(room),
      as<AuditLog>(audit),
      as<UnitOfWork>(uow),
    );

  it('the owner removes any space and the Room of that space falls (trusted, in its org)', async () => {
    await useCase().execute(actor(OWNER), { hubId: HUB_ID, spaceId: SPACE });
    expect(spaceAccess.requireSpacePermission).not.toHaveBeenCalled();
    expect(hubSpaces.remove).toHaveBeenCalledWith(HUB_ID, SPACE, ORG);
    expect(room.revokeRoom).toHaveBeenCalledWith(
      { kind: 'trusted', organizationId: ORG, actorId: OWNER },
      { hubId: HUB_ID, spaceId: SPACE, reason: 'space_removed_from_hub' },
    );
    expect(calls).toEqual([
      `removeSpace:${HUB_ID}`,
      'revokeRoom:[object Object]',
      'audit:[object Object]',
    ]);
  });

  it('anyone else must be the space Gestor; a space not on the hub is 404', async () => {
    await useCase().execute(actor(GESTOR), { hubId: HUB_ID, spaceId: SPACE });
    expect(spaceAccess.requireSpacePermission).toHaveBeenCalledWith(
      SPACE,
      GESTOR,
      'space.members.manage',
    );
    hubSpaces.remove.mockResolvedValueOnce(false);
    await expect(
      useCase().execute(actor(GESTOR), { hubId: HUB_ID, spaceId: SPACE }),
    ).rejects.toMatchObject({
      constructor: NotFoundError,
      code: 'hub-space-not-found',
    });
  });
});

describe('GrantRoomUseCase', () => {
  const useCase = () =>
    new GrantRoomUseCase(
      as<HubAccess>(access),
      as<HubRepository>(hubs),
      as<HubOrganizationRepository>(links),
      as<HubSpaceRepository>(hubSpaces),
      as<SpaceRoomService>(room),
      as<UnitOfWork>(uow),
    );
  const input = {
    hubId: HUB_ID,
    spaceId: SPACE,
    recoveryPublicKey: 'kit',
    grants: [{ version: 1, wrappedKey: 'wk' }],
  };

  it('owner only; confirmHubLink locks hub -> link (FOR SHARE) -> hub_space (FOR SHARE)', async () => {
    room.grantRoom.mockImplementation(
      async (_a: unknown, i: GrantRoomInput) => {
        calls.push('grantRoom:before-space-lock');
        await i.confirmHubLink(ORG);
        calls.push('grantRoom:space-lock');
        return { hubId: HUB_ID, spaceId: SPACE, roleKey: 'space_reader' };
      },
    );
    await useCase().execute(actor(OWNER), input);
    expect(calls).toEqual([
      `requireOwner:${HUB_ID}`,
      'grantRoom:before-space-lock',
      'lockHub:true',
      `shareLink:${HUB_ID}`,
      `shareHubSpace:${HUB_ID}`,
      'grantRoom:space-lock',
    ]);
    expect(room.grantRoom.mock.calls[0]![1]).toMatchObject(input);
  });

  it('confirmHubLink refuses an unlinked org (422) and a space off the hub (422)', async () => {
    let confirm!: (orgId: string) => Promise<void>;
    room.grantRoom.mockImplementation(
      async (_a: unknown, i: GrantRoomInput) => {
        confirm = i.confirmHubLink;
      },
    );
    await useCase().execute(actor(OWNER), input);
    links.lockForShare.mockResolvedValueOnce(null);
    await expect(confirm(ORG)).rejects.toMatchObject({
      code: 'organization-not-linked',
    });
    hubSpaces.lockForShare.mockResolvedValueOnce(null);
    await expect(confirm(ORG)).rejects.toMatchObject({
      code: 'space-not-on-hub',
    });
    hubs.lockForShare.mockResolvedValueOnce(null);
    await expect(confirm(ORG)).rejects.toMatchObject({
      code: 'hub-not-found',
    });
  });
});

describe('RevokeRoomUseCase', () => {
  const useCase = () =>
    new RevokeRoomUseCase(
      as<HubAccess>(access),
      as<HubSpaceRepository>(hubSpaces),
      as<SpaceRoomService>(room),
      as<UnitOfWork>(uow),
    );

  it('owner: trusted in the org of the hub space; others: as space manager; nothing to revoke is 404', async () => {
    await useCase().execute(actor(OWNER), { hubId: HUB_ID, spaceId: SPACE });
    expect(room.revokeRoom).toHaveBeenLastCalledWith(
      { kind: 'trusted', organizationId: ORG, actorId: OWNER },
      { hubId: HUB_ID, spaceId: SPACE, reason: 'revoked' },
    );
    await useCase().execute(actor(GESTOR), { hubId: HUB_ID, spaceId: SPACE });
    expect(room.revokeRoom).toHaveBeenLastCalledWith(
      { kind: 'space_manager', userId: GESTOR },
      { hubId: HUB_ID, spaceId: SPACE, reason: 'revoked' },
    );
    room.revokeRoom.mockResolvedValueOnce(false);
    await expect(
      useCase().execute(actor(OWNER), { hubId: HUB_ID, spaceId: SPACE }),
    ).rejects.toMatchObject({ code: 'room-not-found' });
    hubSpaces.find.mockResolvedValueOnce(null);
    await expect(
      useCase().execute(actor(OWNER), { hubId: HUB_ID, spaceId: SPACE }),
    ).rejects.toMatchObject({ code: 'room-not-found' });
  });
});

describe('AssignHubRoleUseCase', () => {
  const useCase = () =>
    new AssignHubRoleUseCase(
      as<HubAccess>(access),
      as<OrganizationDirectory>(directory),
      as<HubOrganizationRepository>(links),
      as<HubRoleRepository>(hubRoles),
      as<AuditLog>(audit),
      as<UnitOfWork>(uow),
    );

  it('locks the target membership in a linked org (FOR SHARE) before assigning; audits in the owner personal org', async () => {
    links.listActiveOrgIds.mockResolvedValue([ORG, ORG_B]);
    directory.lockActiveMember
      .mockImplementationOnce(log('lockMember', false))
      .mockImplementationOnce(log('lockMember', true));
    hubRoles.assign.mockImplementation(log('assign'));
    await expect(
      useCase().execute(actor(OWNER), {
        hubId: HUB_ID,
        userId: MEMBER,
        roleKey: 'hub_operator',
      }),
    ).resolves.toEqual({
      hubId: HUB_ID,
      userId: MEMBER,
      roleKey: 'hub_operator',
    });
    expect(calls).toEqual([
      `requireOwner:${HUB_ID}`,
      `lockMember:${ORG}`,
      `lockMember:${ORG_B}`,
      'assign:[object Object]',
      'audit:[object Object]',
    ]);
    expect(audit.record).toHaveBeenCalledWith({
      organizationId: PERSONAL,
      userId: OWNER,
      action: 'hub.role.changed',
      metadata: {
        hubId: HUB_ID,
        targetUserId: MEMBER,
        roleKey: 'hub_operator',
      },
    });
  });

  it('422 for an invalid role, the owner as target and a user outside every linked org', async () => {
    links.listActiveOrgIds.mockResolvedValue([ORG]);
    directory.lockActiveMember.mockResolvedValue(false);
    const run = (userId: string, roleKey: string) =>
      useCase().execute(actor(OWNER), { hubId: HUB_ID, userId, roleKey });
    await expect(run(MEMBER, 'hub_owner')).rejects.toMatchObject({
      code: 'role-invalid',
    });
    await expect(run(OWNER, 'hub_user')).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'hub-owner-protected',
    });
    await expect(run(MEMBER, 'hub_user')).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'user-not-in-linked-organization',
    });
    await expect(run('nope', 'hub_user')).rejects.toMatchObject({
      code: 'user-not-in-linked-organization',
    });
    expect(hubRoles.assign).not.toHaveBeenCalled();
  });

  it('passes the 409 of a system role through', async () => {
    links.listActiveOrgIds.mockResolvedValue([ORG]);
    directory.lockActiveMember.mockResolvedValue(true);
    hubRoles.assign.mockRejectedValueOnce(
      new ConflictError('hub-system-role', 'x'),
    );
    await expect(
      useCase().execute(actor(OWNER), {
        hubId: HUB_ID,
        userId: MEMBER,
        roleKey: 'hub_user',
      }),
    ).rejects.toMatchObject({ code: 'hub-system-role' });
  });
});

describe('DeregisterHubUseCase', () => {
  const useCase = () =>
    new DeregisterHubUseCase(
      as<HubAccess>(access),
      as<HubRepository>(hubs),
      as<HubOrganizationRepository>(links),
      as<HubSpaceRepository>(hubSpaces),
      as<HubRoleRepository>(hubRoles),
      as<SpaceRoomService>(room),
      as<OrganizationDirectory>(directory),
      as<AuditLog>(audit),
      as<UnitOfWork>(uow),
    );

  it('locks the hub FOR UPDATE first, then links, spaces, the Room in EVERY org ever linked, roles, the hub, audits', async () => {
    const hub = makeHub();
    hubs.lockForUpdate.mockImplementation(async () => {
      calls.push(`lockHubForUpdate:${String(inTx)}`);
      return hub;
    });
    // ORG_B: vínculo revogado/recusado (só na lista com lápides)
    links.listAllOrgIds.mockImplementation(log('listAll', [ORG, ORG_B]));
    links.tombstoneAllOfHub.mockImplementation(log('tombstoneLinks', [ORG]));
    hubSpaces.removeAllOfOrganization.mockImplementation(
      async (_h: string, orgId: string) => {
        calls.push(`removeSpaces:${orgId}`);
        return orgId === ORG ? [SPACE] : [];
      },
    );
    room.revokeAllRoomForHub.mockImplementation(log('revokeAllRoom', [SPACE]));
    hubRoles.removeAllOfHub.mockImplementation(log('removeRoles', 3));
    hubs.save.mockImplementation(log('saveHub'));
    await useCase().execute(actor(OWNER), HUB_ID);
    expect(calls).toEqual([
      `requireOwner:${HUB_ID}`,
      'lockHubForUpdate:true',
      `listAll:${HUB_ID}`,
      `tombstoneLinks:${HUB_ID}`,
      `removeSpaces:${ORG}`,
      `removeSpaces:${ORG_B}`,
      'revokeAllRoom:[object Object]',
      `removeRoles:${HUB_ID}`,
      'saveHub:[object Object]',
      'audit:[object Object]',
      'audit:[object Object]',
    ]);
    expect(room.revokeAllRoomForHub).toHaveBeenCalledWith({
      hubId: HUB_ID,
      actorId: OWNER,
      reason: 'hub_deregistered',
      organizationIds: [ORG, ORG_B],
    });
    expect(hub.isDeregistered).toBe(true);
    expect(
      audit.record.mock.calls.map((c) => [c[0].organizationId, c[0].action]),
    ).toEqual([
      [ORG, 'hub.organization.revoked'],
      [PERSONAL, 'hub.deregistered'],
    ]);
    expect(uow.run).toHaveBeenCalledTimes(1);
  });

  it('a hub deregistered meanwhile is 404 and nothing is written', async () => {
    hubs.lockForUpdate.mockResolvedValueOnce(null);
    await expect(useCase().execute(actor(OWNER), HUB_ID)).rejects.toMatchObject(
      { code: 'hub-not-found' },
    );
    expect(links.tombstoneAllOfHub).not.toHaveBeenCalled();
    expect(hubs.save).not.toHaveBeenCalled();
  });
});
