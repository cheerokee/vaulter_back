import type { AuditLog } from '../../organizations/application/audit-log.js';
import { MemberRemovedHooks } from '../../shared/application/member-removed-hooks.js';
import { SpaceMemberLeftHooks } from '../../shared/application/space-member-left-hooks.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { SpaceRoomService } from '../../spaces/application/space-room.service.js';
import { HubOrganizationLink } from '../domain/hub-organization-link.js';
import type { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import type { HubRoleRepository } from '../domain/hub-role.repository.js';
import type { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { Hub } from '../domain/hub.js';
import type { HubRepository } from '../domain/hub.repository.js';
import type { HubLinkCascade } from './hub-link-cascade.js';
import { HubsMemberRemovedHook } from './member-removed.hook.js';
import type { HubPersonSessions } from './hub-person-sessions.js';
import { HubsSpaceMemberLeftHook } from './space-member-left.hook.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const HUB_A = '019a0000-0000-7000-8000-0000000000aa';
const HUB_B = '019a0000-0000-7000-8000-0000000000ab';
const ORG = '019a0000-0000-7000-8000-0000000000c1';
const OWNER = '019a0000-0000-7000-8000-0000000000a1';
const ADMIN = '019a0000-0000-7000-8000-0000000000a2';
const MEMBER = '019a0000-0000-7000-8000-0000000000b1';
const SPACE = '019a0000-0000-7000-8000-0000000005a1';
const as = <T>(x: unknown) => x as T;

const link = (hubId: string, status: 'approved' | 'rejected' = 'approved') => {
  const l = HubOrganizationLink.requestByOther({
    hubId,
    organizationId: ORG,
    userId: MEMBER,
    policy: 'any_member_hub',
    now: NOW,
  });
  if (status === 'approved') l.approveAsOwner(OWNER, NOW, 'any_member_hub');
  else l.reject();
  return l;
};
const hub = (id: string) =>
  Hub.restore(
    {
      ownerUserId: OWNER,
      name: 'Sala',
      signingPublicKey: 's',
      encryptionPublicKey: 'e',
      lastSeenAt: null,
      deletedAt: null,
    },
    id,
  );

const calls: string[] = [];
const links = {
  listOwnedInOrganization: vi.fn(),
  lockForUpdate: vi.fn(),
  listApprovedHubIdsOfOrganization: vi.fn(),
  lockForShare: vi.fn(),
};
const hubs = { lockForShare: vi.fn(), lockForUpdate: vi.fn() };
const hubRoles = { removeUsersWithoutLinkedOrg: vi.fn() };
const hubSpaces = { lockAllOfOrganization: vi.fn() };
const cascade = { unlink: vi.fn() };
const room = { revokeRoom: vi.fn() };
const audit = { record: vi.fn() };
const personSessions = {
  revokeLostAccess: vi.fn(async (hubIds: Iterable<string>) => {
    calls.push(`revokeLostAccess:${[...hubIds].join(',')}`);
  }),
};
const uow = {
  withContext: vi.fn(async (ctx: unknown, work: () => Promise<unknown>) => {
    calls.push(`withContext:${JSON.stringify(ctx)}`);
    return work();
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
});

describe('HubsMemberRemovedHook', () => {
  const make = (hooks = new MemberRemovedHooks()) =>
    new HubsMemberRemovedHook(
      hooks,
      as<HubRepository>(hubs),
      as<HubOrganizationRepository>(links),
      as<HubSpaceRepository>(hubSpaces),
      as<HubRoleRepository>(hubRoles),
      as<HubLinkCascade>(cascade),
      as<AuditLog>(audit),
      as<HubPersonSessions>(personSessions),
      as<UnitOfWork>(uow),
    );
  const ctx = {
    organizationId: ORG,
    userId: OWNER,
    actorId: ADMIN,
    reason: 'removed' as const,
    now: NOW,
  };

  it('registers a lock phase before the spaces hook and the cascade after it; unregisters both on destroy', async () => {
    const hooks = new MemberRemovedHooks();
    const order: string[] = [];
    hooks.register({
      name: 'spaces.member-removed',
      onMemberRemoved: async () => {
        order.push('spaces');
      },
    });
    const hook = make(hooks);
    links.listOwnedInOrganization.mockImplementation(async () => {
      order.push('hubs:owned');
      return [];
    });
    links.listApprovedHubIdsOfOrganization.mockImplementation(async () => {
      order.push('hubs:roles');
      return [];
    });
    hook.onModuleInit();
    await hooks.run(ctx);
    expect(order).toEqual(['hubs:owned', 'spaces', 'hubs:owned', 'hubs:roles']);
    hook.onModuleDestroy();
    order.length = 0;
    await hooks.run(ctx);
    expect(order).toEqual(['spaces']);
  });

  it('lock phase: hub share -> link update -> hub_space rows, for live links only, with no write', async () => {
    links.listOwnedInOrganization.mockResolvedValue([
      link(HUB_A),
      link(HUB_B, 'rejected'),
    ]);
    hubs.lockForShare.mockImplementation(async (id: string) => {
      calls.push(`lockHub:${id}`);
      return hub(id);
    });
    links.lockForUpdate.mockImplementation(async (id: string) => {
      calls.push(`lockLink:${id}`);
      return id === HUB_A ? link(HUB_A) : link(HUB_B, 'rejected');
    });
    hubSpaces.lockAllOfOrganization.mockImplementation(async (id: string) => {
      calls.push(`lockHubSpaces:${id}`);
      return [SPACE];
    });
    await make().lockOwnedLinks(ctx);
    expect(calls).toEqual([
      `lockHub:${HUB_A}`,
      `lockLink:${HUB_A}`,
      `lockHubSpaces:${HUB_A}`,
      `lockHub:${HUB_B}`,
      `lockLink:${HUB_B}`,
    ]);
    expect(cascade.unlink).not.toHaveBeenCalled();
    expect(hubRoles.removeUsersWithoutLinkedOrg).not.toHaveBeenCalled();
  });

  it('cascade phase: unlinks each live link of her hubs (hub share -> link update -> cascade), then drops roles', async () => {
    links.listOwnedInOrganization.mockResolvedValue([
      link(HUB_A),
      link(HUB_B, 'rejected'),
    ]);
    hubs.lockForShare.mockImplementation(async (id: string) => {
      calls.push(`lockHub:${id}`);
      return hub(id);
    });
    links.lockForUpdate.mockImplementation(async (id: string) => {
      calls.push(`lockLink:${id}`);
      return id === HUB_A ? link(HUB_A) : link(HUB_B, 'rejected');
    });
    cascade.unlink.mockImplementation(async (l: HubOrganizationLink) => {
      calls.push(`unlink:${l.hubId}`);
    });
    links.listApprovedHubIdsOfOrganization.mockResolvedValue([HUB_B]);
    hubRoles.removeUsersWithoutLinkedOrg.mockImplementation(
      async (id: string) => {
        calls.push(`removeRoles:${id}`);
        return [MEMBER];
      },
    );
    await make().onMemberRemoved(ctx);
    expect(calls).toEqual([
      `lockHub:${HUB_A}`,
      `lockLink:${HUB_A}`,
      `unlink:${HUB_A}`,
      `lockHub:${HUB_B}`,
      `lockLink:${HUB_B}`,
      `withContext:${JSON.stringify({ hubId: HUB_B })}`,
      `removeRoles:${HUB_B}`,
      // Por último: as sessões presas aos Hubs tocados (os dela e os vinculados à organização).
      `revokeLostAccess:${HUB_A},${HUB_B},${HUB_B}`,
    ]);
    expect(cascade.unlink.mock.calls[0]![1]).toEqual({
      actorId: ADMIN,
      reason: 'owner_left_organization',
    });
    expect(audit.record).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: ADMIN,
      action: 'hub.role.changed',
      metadata: {
        hubId: HUB_B,
        targetUserId: MEMBER,
        roleKey: null,
        reason: 'no_linked_organization',
      },
    });
  });

  it('propagates a failure (the exit is undone)', async () => {
    links.listOwnedInOrganization.mockResolvedValue([]);
    links.listApprovedHubIdsOfOrganization.mockResolvedValue([HUB_A]);
    hubRoles.removeUsersWithoutLinkedOrg.mockRejectedValueOnce(
      new Error('boom'),
    );
    await expect(make().onMemberRemoved(ctx)).rejects.toThrow('boom');
  });
});

describe('HubsSpaceMemberLeftHook', () => {
  const make = (hooks = new SpaceMemberLeftHooks()) =>
    new HubsSpaceMemberLeftHook(
      hooks,
      as<HubOrganizationRepository>(links),
      as<SpaceRoomService>(room),
    );
  const ctx = { organizationId: ORG, spaceId: SPACE, userId: OWNER, now: NOW };

  it('only READS the owner links (no lock) and revokes the Room of that space as trusted on each of her hubs', async () => {
    links.listOwnedInOrganization.mockResolvedValue([link(HUB_A), link(HUB_B)]);
    room.revokeRoom.mockResolvedValue(true);
    const hooks = new SpaceMemberLeftHooks();
    const hook = make(hooks);
    hook.onModuleInit();
    await hooks.run(ctx);
    expect(links.listOwnedInOrganization).toHaveBeenCalledWith(ORG, OWNER);
    expect(links.lockForUpdate).not.toHaveBeenCalled();
    expect(links.lockForShare).not.toHaveBeenCalled();
    expect(hubs.lockForShare).not.toHaveBeenCalled();
    expect(hubs.lockForUpdate).not.toHaveBeenCalled();
    expect(room.revokeRoom.mock.calls).toEqual([
      [
        { kind: 'trusted', organizationId: ORG, actorId: null },
        { hubId: HUB_A, spaceId: SPACE, reason: 'owner_left_space' },
      ],
      [
        { kind: 'trusted', organizationId: ORG, actorId: null },
        { hubId: HUB_B, spaceId: SPACE, reason: 'owner_left_space' },
      ],
    ]);
    hook.onModuleDestroy();
    room.revokeRoom.mockClear();
    await hooks.run(ctx);
    expect(room.revokeRoom).not.toHaveBeenCalled();
  });

  it('someone who owns no hub: nothing happens', async () => {
    links.listOwnedInOrganization.mockResolvedValue([]);
    await make().onSpaceMemberLeft({ ...ctx, userId: MEMBER });
    expect(room.revokeRoom).not.toHaveBeenCalled();
  });
});
