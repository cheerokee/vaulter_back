import type { AuditLog } from '../../organizations/application/audit-log.js';
import type { OrganizationAccess } from '../../organizations/application/organization-access.js';
import type { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { SpaceRoomService } from '../../spaces/application/space-room.service.js';
import {
  HubOrganizationLink,
  type HubLinkPolicy,
} from '../domain/hub-organization-link.js';
import type { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import type { HubRoleRepository } from '../domain/hub-role.repository.js';
import type { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { Hub } from '../domain/hub.js';
import type { HubRepository } from '../domain/hub.repository.js';
import { LinkCode } from '../domain/link-code.js';
import type { LinkCodeRepository } from '../domain/link-code.repository.js';
import { ApproveHubLinkUseCase } from './approve-hub-link.use-case.js';
import type { HubAccess } from './hub-access.js';
import { HubLinkCascade } from './hub-link-cascade.js';
import { IssueLinkCodeUseCase } from './issue-link-code.use-case.js';
import { LinkHubOrganizationUseCase } from './link-hub-organization.use-case.js';
import type { HubCodeHasher } from './ports/hub-code-hasher.js';
import { RejectHubLinkUseCase } from './reject-hub-link.use-case.js';
import { RequestHubLinkUseCase } from './request-hub-link.use-case.js';
import { UnlinkHubOrganizationUseCase } from './unlink-hub-organization.use-case.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const HUB_ID = '019a0000-0000-7000-8000-0000000000aa';
const ORG = '019a0000-0000-7000-8000-0000000000c1';
const OWNER = '019a0000-0000-7000-8000-0000000000a1';
const ADMIN = '019a0000-0000-7000-8000-0000000000a2';
const MEMBER = '019a0000-0000-7000-8000-0000000000b1';
const SPACE = '019a0000-0000-7000-8000-0000000005a1';
const actor = (userId: string) => ({ userId, sessionId: 's1' });
const ids = { hubId: HUB_ID, organizationId: ORG };

const hub = Hub.restore(
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
const pendingByMember = () =>
  HubOrganizationLink.requestByOther({
    ...ids,
    userId: MEMBER,
    policy: 'admin_approved',
    now: NOW,
  });
/** The owner already consented under admin_approved; the org has since relaxed to any_member_hub. */
const pendingOwnerConsented = () =>
  HubOrganizationLink.ownerLinks({
    ...ids,
    userId: OWNER,
    policy: 'admin_approved',
    now: NOW,
  });

const calls: string[] = [];
const log =
  (name: string, value?: unknown) =>
  async (...args: unknown[]) => {
    calls.push(`${name}${args.length ? `:${String(args[0])}` : ''}`);
    return value;
  };
const access = { find: vi.fn(), requireOwner: vi.fn() };
const orgAccess = {
  requireMember: vi.fn(),
  requirePermission: vi.fn(),
  hasPermission: vi.fn(),
};
const directory = { hubLinkPolicy: vi.fn(), lockActiveMember: vi.fn() };
const hubs = { lockForShare: vi.fn() };
const links = { lockForUpdate: vi.fn(), upsert: vi.fn() };
const linkCodes = { consume: vi.fn(), expireStale: vi.fn(), create: vi.fn() };
const codes = { hashLinkCode: vi.fn(), newCode: vi.fn() };
const audit = { record: vi.fn() };
const cascade = { unlink: vi.fn() };
const hubSpaces = { removeAllOfOrganization: vi.fn() };
const hubRoles = { removeUsersWithoutLinkedOrg: vi.fn() };
const room = { revokeRoomForOrganization: vi.fn() };
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
  setContext: vi.fn(log('ctx')),
  withContext: vi.fn(async (ctx: unknown, work: () => Promise<unknown>) => {
    calls.push(`withContext:${JSON.stringify(ctx)}`);
    return work();
  }),
};
const as = <T>(x: unknown) => x as T;

let policy: HubLinkPolicy;
let link: HubOrganizationLink | null;

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  policy = 'admin_approved';
  link = pendingByMember();
  access.find.mockImplementation(async (_h: string, userId: string) =>
    userId === OWNER ? { hub, role: 'hub_owner' } : null,
  );
  access.requireOwner.mockImplementation(log('requireOwner', hub));
  orgAccess.requireMember.mockImplementation(log('requireMember'));
  orgAccess.requirePermission.mockImplementation(log('requirePermission'));
  orgAccess.hasPermission.mockResolvedValue(false);
  directory.hubLinkPolicy.mockImplementation(async () => policy);
  directory.lockActiveMember.mockImplementation(log('lockMember', true));
  hubs.lockForShare.mockImplementation(async (id: string) => {
    calls.push(`lockHub:${String(inTx)}`);
    return id === HUB_ID ? hub : null;
  });
  links.lockForUpdate.mockImplementation(async () => {
    calls.push('lockLink');
    return link;
  });
  links.upsert.mockImplementation(log('upsert'));
  audit.record.mockImplementation(log('audit'));
  codes.hashLinkCode.mockImplementation(async (c: string) => `h:${c}`);
});
afterEach(() => vi.useRealTimers());

describe('approve, reject and unlink never reveal whether a hub exists to a non-owner', () => {
  const LINK_404 = { constructor: NotFoundError, code: 'hub-link-not-found' };
  const cases: [
    string,
    () => {
      execute: (a: ReturnType<typeof actor>, i: typeof ids) => Promise<unknown>;
    },
  ][] = [
    [
      'approve',
      () =>
        new ApproveHubLinkUseCase(
          as<HubAccess>(access),
          as<OrganizationAccess>(orgAccess),
          as<OrganizationDirectory>(directory),
          as<HubRepository>(hubs),
          as<HubOrganizationRepository>(links),
          as<AuditLog>(audit),
          as<UnitOfWork>(uow),
        ),
    ],
    [
      'reject',
      () =>
        new RejectHubLinkUseCase(
          as<HubAccess>(access),
          as<OrganizationAccess>(orgAccess),
          as<HubRepository>(hubs),
          as<HubOrganizationRepository>(links),
          as<AuditLog>(audit),
          as<UnitOfWork>(uow),
        ),
    ],
    [
      'unlink',
      () =>
        new UnlinkHubOrganizationUseCase(
          as<HubAccess>(access),
          as<OrganizationAccess>(orgAccess),
          as<HubRepository>(hubs),
          as<HubOrganizationRepository>(links),
          as<HubLinkCascade>(cascade),
          as<UnitOfWork>(uow),
        ),
    ],
  ];

  it.each(cases)(
    '%s: an unknown/deregistered hub and an existing hub without a link give the same 404 to an admin',
    async (_name, make) => {
      // admin path (any user is admin of their personal org): unknown hub id
      hubs.lockForShare.mockResolvedValueOnce(null);
      const unknown = await make()
        .execute(actor(ADMIN), ids)
        .catch((e: unknown) => e);
      // existing hub, no link with that org
      link = null;
      const unlinked = await make()
        .execute(actor(ADMIN), ids)
        .catch((e: unknown) => e);
      expect(unknown).toMatchObject(LINK_404);
      expect(unlinked).toMatchObject(LINK_404);
      expect((unknown as Error).constructor).toBe(
        (unlinked as Error).constructor,
      );
      // the owner already knows the hub: a deregistered one is hub-not-found
      hubs.lockForShare.mockResolvedValueOnce(null);
      await expect(make().execute(actor(OWNER), ids)).rejects.toMatchObject({
        code: 'hub-not-found',
      });
      expect(links.upsert).not.toHaveBeenCalled();
    },
  );
});

describe('LinkHubOrganizationUseCase', () => {
  const useCase = () =>
    new LinkHubOrganizationUseCase(
      as<HubAccess>(access),
      as<OrganizationAccess>(orgAccess),
      as<OrganizationDirectory>(directory),
      as<HubRepository>(hubs),
      as<HubOrganizationRepository>(links),
      as<AuditLog>(audit),
      as<UnitOfWork>(uow),
    );

  it('authorizes (owner, then member under the membership lock) before locking hub -> link and writing', async () => {
    link = null;
    policy = 'any_member_hub';
    const view = await useCase().execute(actor(OWNER), ids);
    expect(view.status).toBe('approved');
    expect(calls).toEqual([
      `ctx:[object Object]`,
      `requireOwner:${HUB_ID}`,
      `lockMember:${ORG}`,
      `requireMember:${ORG}`,
      'lockHub:true',
      'lockLink',
      'upsert:[object Object]',
      'audit:[object Object]',
      'audit:[object Object]',
    ]);
    expect(audit.record.mock.calls.map((c) => c[0].action)).toEqual([
      'hub.organization.requested',
      'hub.organization.approved',
    ]);
  });

  it('stays pending under admin_approved; never writes when authorization fails', async () => {
    link = null;
    await expect(useCase().execute(actor(OWNER), ids)).resolves.toMatchObject({
      status: 'pending',
    });
    vi.clearAllMocks();
    access.requireOwner.mockRejectedValueOnce(
      new PermissionDeniedError('permission-denied', 'x'),
    );
    await expect(useCase().execute(actor(MEMBER), ids)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    orgAccess.requireMember.mockRejectedValueOnce(
      new NotFoundError('organization-not-found', 'x'),
    );
    await expect(useCase().execute(actor(OWNER), ids)).rejects.toMatchObject({
      code: 'organization-not-found',
    });
    expect(links.upsert).not.toHaveBeenCalled();
  });
});

describe('RequestHubLinkUseCase', () => {
  const code = () =>
    LinkCode.restore(
      {
        hubId: HUB_ID,
        codeHash: 'h:12345678',
        expiresAt: new Date(NOW.getTime() + 60_000),
        usedAt: NOW,
      },
      '019a0000-0000-7000-8000-0000000000e1',
    );
  const useCase = () =>
    new RequestHubLinkUseCase(
      as<OrganizationAccess>(orgAccess),
      as<OrganizationDirectory>(directory),
      as<HubCodeHasher>(codes),
      as<LinkCodeRepository>(linkCodes),
      as<HubRepository>(hubs),
      as<HubOrganizationRepository>(links),
      as<AuditLog>(audit),
      as<UnitOfWork>(uow),
    );
  const INVALID = {
    constructor: DomainValidationError,
    code: 'link-code-invalid',
  };

  it('checks membership BEFORE consuming the code, then hub -> link, and never returns the hub id', async () => {
    link = null;
    linkCodes.consume.mockImplementation(log('consume', code()));
    const view = await useCase().execute(actor(MEMBER), {
      linkCode: '12345678',
      organizationId: ORG,
    });
    expect(view).toEqual({ organizationId: ORG, status: 'pending' });
    expect(calls.slice(1, 5)).toEqual([
      `requireMember:${ORG}`,
      'consume:h:12345678',
      'lockHub:true',
      'lockLink',
    ]);
    expect((links.upsert.mock.calls[0]![0] as HubOrganizationLink).status).toBe(
      'pending',
    );
  });

  it('a malformed code never reaches the database; unknown, used or deregistered-hub codes are the same 422', async () => {
    await expect(
      useCase().execute(actor(MEMBER), {
        linkCode: '1234',
        organizationId: ORG,
      }),
    ).rejects.toMatchObject(INVALID);
    expect(codes.hashLinkCode).not.toHaveBeenCalled();
    linkCodes.consume.mockResolvedValueOnce(null);
    await expect(
      useCase().execute(actor(MEMBER), {
        linkCode: '12345678',
        organizationId: ORG,
      }),
    ).rejects.toMatchObject(INVALID);
    linkCodes.consume.mockResolvedValueOnce(code());
    hubs.lockForShare.mockResolvedValueOnce(null);
    await expect(
      useCase().execute(actor(MEMBER), {
        linkCode: '12345678',
        organizationId: ORG,
      }),
    ).rejects.toMatchObject(INVALID);
    orgAccess.requireMember.mockRejectedValueOnce(
      new NotFoundError('organization-not-found', 'x'),
    );
    linkCodes.consume.mockClear();
    await expect(
      useCase().execute(actor(MEMBER), {
        linkCode: '12345678',
        organizationId: ORG,
      }),
    ).rejects.toMatchObject({ code: 'organization-not-found' });
    expect(linkCodes.consume).not.toHaveBeenCalled();
    expect(links.upsert).not.toHaveBeenCalled();
  });
});

describe('IssueLinkCodeUseCase', () => {
  const useCase = () =>
    new IssueLinkCodeUseCase(
      as<LinkCodeRepository>(linkCodes),
      as<HubCodeHasher>(codes),
    );

  it('expires stale codes first, stores only the hash and retries a collision (up to 5 tries)', async () => {
    let n = 0;
    codes.newCode.mockImplementation(() => String(10_000_000 + n++));
    linkCodes.expireStale.mockImplementation(log('expireStale', 0));
    linkCodes.create
      .mockImplementationOnce(async () => {
        calls.push('create');
        throw new ConflictError('link-code-collision', 'x');
      })
      .mockImplementationOnce(async () => {
        calls.push('create');
      });
    const res = await useCase().execute(HUB_ID);
    expect(res.linkCode).toBe('10000001');
    expect(res.expiresAt).toEqual(new Date(NOW.getTime() + 10 * 60_000));
    expect(calls).toEqual([
      `expireStale:${NOW.toString()}`,
      'create',
      'create',
    ]);
    const stored = linkCodes.create.mock.calls[1]![0] as LinkCode;
    expect(stored.codeHash).toBe('h:10000001');
    expect(stored.hubId).toBe(HUB_ID);

    linkCodes.create.mockRejectedValue(
      new ConflictError('link-code-collision', 'x'),
    );
    await expect(useCase().execute(HUB_ID)).rejects.toMatchObject({
      code: 'link-code-collision',
    });
    expect(linkCodes.create).toHaveBeenCalledTimes(2 + 5);
  });
});

describe('ApproveHubLinkUseCase', () => {
  const useCase = () =>
    new ApproveHubLinkUseCase(
      as<HubAccess>(access),
      as<OrganizationAccess>(orgAccess),
      as<OrganizationDirectory>(directory),
      as<HubRepository>(hubs),
      as<HubOrganizationRepository>(links),
      as<AuditLog>(audit),
      as<UnitOfWork>(uow),
    );

  it('re-settles with the CURRENT policy when the owner already consented (owner route)', async () => {
    link = pendingOwnerConsented();
    policy = 'any_member_hub';
    await expect(useCase().execute(actor(OWNER), ids)).resolves.toMatchObject({
      status: 'approved',
    });
    const saved = links.upsert.mock.calls[0]![0] as HubOrganizationLink;
    expect(saved.ownerApprovedAt).toEqual(NOW);
    expect(saved.orgApprovedAt).toBeNull();
  });

  it('re-settles with the CURRENT policy through the admin route too', async () => {
    link = pendingOwnerConsented();
    policy = 'any_member_hub';
    await expect(useCase().execute(actor(ADMIN), ids)).resolves.toMatchObject({
      status: 'approved',
    });
    expect(orgAccess.requirePermission).toHaveBeenCalledWith(
      ORG,
      ADMIN,
      'org.hubs.approve',
    );
  });

  it('owner alone leaves admin_approved pending; an owner who is also admin gives both consents', async () => {
    await expect(useCase().execute(actor(OWNER), ids)).resolves.toMatchObject({
      status: 'pending',
    });
    link = pendingByMember();
    orgAccess.hasPermission.mockResolvedValueOnce(true);
    await expect(useCase().execute(actor(OWNER), ids)).resolves.toMatchObject({
      status: 'approved',
    });
    expect(audit.record.mock.calls.at(-1)![0].metadata).toEqual({
      hubId: HUB_ID,
      as: 'owner_and_admin',
      status: 'approved',
    });
  });

  it('authorizes before any lock; a missing link is 404; not pending is 409', async () => {
    orgAccess.requirePermission.mockRejectedValueOnce(
      new PermissionDeniedError('permission-denied', 'x'),
    );
    await expect(useCase().execute(actor(MEMBER), ids)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(hubs.lockForShare).not.toHaveBeenCalled();
    link = null;
    await expect(useCase().execute(actor(ADMIN), ids)).rejects.toMatchObject({
      constructor: NotFoundError,
      code: 'hub-link-not-found',
    });
    link = pendingByMember();
    link.reject();
    await expect(useCase().execute(actor(ADMIN), ids)).rejects.toMatchObject({
      code: 'link-not-pending',
    });
    expect(links.upsert).not.toHaveBeenCalled();
  });
});

describe('RejectHubLinkUseCase', () => {
  it('rejects a pending request (owner or admin) after hub -> link locks', async () => {
    const useCase = new RejectHubLinkUseCase(
      as<HubAccess>(access),
      as<OrganizationAccess>(orgAccess),
      as<HubRepository>(hubs),
      as<HubOrganizationRepository>(links),
      as<AuditLog>(audit),
      as<UnitOfWork>(uow),
    );
    await expect(useCase.execute(actor(ADMIN), ids)).resolves.toMatchObject({
      status: 'rejected',
    });
    expect(calls.slice(1)).toEqual([
      `requirePermission:${ORG}`,
      'lockHub:true',
      'lockLink',
      'upsert:[object Object]',
      'audit:[object Object]',
    ]);
  });
});

describe('UnlinkHubOrganizationUseCase', () => {
  const useCase = () =>
    new UnlinkHubOrganizationUseCase(
      as<HubAccess>(access),
      as<OrganizationAccess>(orgAccess),
      as<HubRepository>(hubs),
      as<HubOrganizationRepository>(links),
      as<HubLinkCascade>(cascade),
      as<UnitOfWork>(uow),
    );

  it('owner or admin; locks hub (share) -> link (update) and runs the cascade in the same transaction', async () => {
    cascade.unlink.mockImplementation(async () => {
      calls.push(`cascade:${String(inTx)}`);
    });
    await useCase().execute(actor(OWNER), ids);
    expect(calls.slice(1)).toEqual([
      'lockHub:true',
      'lockLink',
      'cascade:true',
    ]);
    expect(cascade.unlink).toHaveBeenCalledWith(link, {
      actorId: OWNER,
      reason: 'unlinked',
    });
    expect(orgAccess.requirePermission).not.toHaveBeenCalled();
    await useCase().execute(actor(ADMIN), ids);
    expect(orgAccess.requirePermission).toHaveBeenCalledWith(
      ORG,
      ADMIN,
      'org.hubs.approve',
    );
  });

  it('a non-member of the organization (not the owner) gets 404 and nothing is locked', async () => {
    orgAccess.requirePermission.mockRejectedValueOnce(
      new NotFoundError('organization-not-found', 'x'),
    );
    await expect(useCase().execute(actor(MEMBER), ids)).rejects.toMatchObject({
      code: 'organization-not-found',
    });
    expect(hubs.lockForShare).not.toHaveBeenCalled();
    expect(cascade.unlink).not.toHaveBeenCalled();
  });
});

describe('HubLinkCascade', () => {
  it('revokes the link, then hub spaces -> Room (which marks the rotation) -> roles in the hub context -> audits', async () => {
    const cascadeUnderTest = new HubLinkCascade(
      as<HubOrganizationRepository>(links),
      as<HubSpaceRepository>(hubSpaces),
      as<HubRoleRepository>(hubRoles),
      as<SpaceRoomService>(room),
      as<AuditLog>(audit),
      as<UnitOfWork>(uow),
    );
    hubSpaces.removeAllOfOrganization.mockImplementation(
      log('removeSpaces', [SPACE]),
    );
    room.revokeRoomForOrganization.mockImplementation(
      log('revokeRoom', [SPACE]),
    );
    hubRoles.removeUsersWithoutLinkedOrg.mockImplementation(
      log('removeRoles', [MEMBER]),
    );
    const approved = HubOrganizationLink.ownerLinks({
      ...ids,
      userId: OWNER,
      policy: 'any_member_hub',
      now: NOW,
    });
    await cascadeUnderTest.unlink(approved, {
      actorId: ADMIN,
      reason: 'unlinked',
    });
    expect(approved.status).toBe('revoked');
    expect(calls).toEqual([
      'upsert:[object Object]',
      `removeSpaces:${HUB_ID}`,
      'revokeRoom:[object Object]',
      `withContext:${JSON.stringify({ hubId: HUB_ID })}`,
      `removeRoles:${HUB_ID}`,
      'audit:[object Object]',
      'audit:[object Object]',
      'audit:[object Object]',
    ]);
    expect(room.revokeRoomForOrganization).toHaveBeenCalledWith({
      hubId: HUB_ID,
      organizationId: ORG,
      actorId: ADMIN,
      reason: 'hub_unlinked',
    });
    expect(
      audit.record.mock.calls.map((c) => [c[0].action, c[0].metadata]),
    ).toEqual([
      [
        'hub.organization.revoked',
        {
          hubId: HUB_ID,
          reason: 'unlinked',
          spaceIds: [SPACE],
          roomSpaceIds: [SPACE],
        },
      ],
      [
        'hub.space.removed',
        { hubId: HUB_ID, spaceId: SPACE, reason: 'hub_unlinked' },
      ],
      [
        'hub.role.changed',
        {
          hubId: HUB_ID,
          targetUserId: MEMBER,
          roleKey: null,
          reason: 'no_linked_organization',
        },
      ],
    ]);
  });

  it('refuses a link that is not active or pending (409) before writing anything', async () => {
    const cascadeUnderTest = new HubLinkCascade(
      as<HubOrganizationRepository>(links),
      as<HubSpaceRepository>(hubSpaces),
      as<HubRoleRepository>(hubRoles),
      as<SpaceRoomService>(room),
      as<AuditLog>(audit),
      as<UnitOfWork>(uow),
    );
    const rejected = pendingByMember();
    rejected.reject();
    await expect(
      cascadeUnderTest.unlink(rejected, { actorId: OWNER, reason: 'unlinked' }),
    ).rejects.toMatchObject({ code: 'link-not-active' });
    expect(links.upsert).not.toHaveBeenCalled();
  });
});
