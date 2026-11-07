import type { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import type { UserDirectory } from '../../identity/application/user-directory.js';
import type { HubAdministration } from '../../hubs/application/hub-administration.js';
import type { OrganizationAdministration } from '../../organizations/application/organization-administration.js';
import {
  DomainValidationError,
  NotFoundError,
} from '../../shared/domain/errors.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import {
  PLATFORM_ROLES,
  type PlatformPermission,
  type PlatformRoleKey,
} from '../domain/platform-catalog.js';
import type { PlatformRoleRepository } from '../domain/platform-role.repository.js';
import { SupportRequest } from '../domain/support-request.js';
import type { SupportRequestRepository } from '../domain/support-request.repository.js';
import { CreateSupportRequestUseCase } from './create-support-request.use-case.js';
import { DecideSupportRequestUseCase } from './decide-support-request.use-case.js';
import { GetSupportRequestUseCase } from './get-support-request.use-case.js';
import { ListSupportRequestsUseCase } from './list-support-requests.use-case.js';
import { PlatformAccess } from './platform-access.js';
import type { PlatformAudit } from './platform-audit.js';
import type { SupportRequestExecutor } from './support-request-executor.js';

const ADMIN = '019a1b2c-0000-7000-8000-0000000000a1';
const ADMIN2 = '019a1b2c-0000-7000-8000-0000000000a2';
const SUPPORT = '019a1b2c-0000-7000-8000-0000000000b1';
const SUPPORT2 = '019a1b2c-0000-7000-8000-0000000000b2';
const USER = '019a1b2c-0000-7000-8000-0000000000c1';
const HUB = '019a1b2c-0000-7000-8000-0000000000d1';
const ORG = '019a1b2c-0000-7000-8000-0000000000e1';
const DAY = 86_400_000;
const actor = (userId: string) => ({ userId, sessionId: 's1' });

const assigned = new Map<string, PlatformRoleKey[]>();
const calls: string[] = [];
const roles = {
  permissionsOf: vi.fn(async (u: string) => {
    const set = new Set<PlatformPermission>();
    for (const r of assigned.get(u) ?? [])
      PLATFORM_ROLES[r].permissions.forEach((p) => set.add(p));
    return [...set].sort();
  }),
  hasAnyRole: vi.fn(async (u: string) => (assigned.get(u)?.length ?? 0) > 0),
};
const stored = new Map<string, SupportRequest>();
const repo = {
  insert: vi.fn(async (r: SupportRequest) => {
    calls.push('repo.insert');
    stored.set(r.id, r);
  }),
  save: vi.fn(async (r: SupportRequest) => {
    calls.push(`repo.save:${r.status}`);
  }),
  findById: vi.fn(async (id: string) => stored.get(id) ?? null),
  lockById: vi.fn(async (id: string) => {
    calls.push('repo.lockById');
    return stored.get(id) ?? null;
  }),
  lockDuePending: vi.fn(async (now: Date) =>
    [...stored.values()].filter(
      (r) => r.status === 'pending' && !r.isApproved && now >= r.expiresAt,
    ),
  ),
  list: vi.fn(async (filter: { requestedBy?: string; status?: string }) => ({
    items: [...stored.values()].filter(
      (r) =>
        (!filter.requestedBy || r.requestedBy === filter.requestedBy) &&
        (!filter.status || r.status === filter.status),
    ),
    nextCursor: null,
  })),
};
const audit = {
  record: vi.fn(async (e: { action: string }) => {
    calls.push(e.action);
  }),
};
const verifier = {
  verify: vi.fn(async () => {
    calls.push('verifier.verify');
  }),
};
const directory = {
  findPublicByIds: vi.fn(async (ids: string[]) =>
    ids
      .filter((i) => i === USER || i.startsWith('019a1b2c'))
      .map((id) => ({ id })),
  ),
};
const hubAdmin = {
  summary: vi.fn(async (id: string) => (id === HUB ? { hubId: HUB } : null)),
};
const orgAdmin = {
  summary: vi.fn(async (id: string) =>
    id === ORG ? { organizationId: ORG } : null,
  ),
};
const executor = {
  execute: vi.fn(async (r: SupportRequest, now: Date) => {
    calls.push('executor.execute');
    r.markExecuted(now);
  }),
};
const uow = {
  run: vi.fn(async (work: () => Promise<unknown>) => {
    calls.push('uow.run');
    return work();
  }),
};

const access = new PlatformAccess(roles as unknown as PlatformRoleRepository);
const deps = {
  access,
  repo: repo as unknown as SupportRequestRepository,
  audit: audit as unknown as PlatformAudit,
  uow: uow as unknown as UnitOfWork,
};
const create = new CreateSupportRequestUseCase(
  deps.access,
  roles as unknown as PlatformRoleRepository,
  deps.repo,
  deps.audit,
  executor as unknown as SupportRequestExecutor,
  verifier as unknown as CurrentAuthProofVerifier,
  directory as unknown as UserDirectory,
  hubAdmin as unknown as HubAdministration,
  orgAdmin as unknown as OrganizationAdministration,
  deps.uow,
);
const decide = new DecideSupportRequestUseCase(
  deps.access,
  deps.repo,
  deps.audit,
  executor as unknown as SupportRequestExecutor,
  verifier as unknown as CurrentAuthProofVerifier,
  deps.uow,
);
const list = new ListSupportRequestsUseCase(
  deps.access,
  deps.repo,
  deps.audit,
  deps.uow,
);
const get = new GetSupportRequestUseCase(
  deps.access,
  deps.repo,
  deps.audit,
  deps.uow,
);

const deregisterInput = {
  type: 'hub_force_deregister' as const,
  hubId: HUB,
  reason: 'Owner lost the account',
  evidence: 'Invoice 4567',
  currentAuthProof: 'proof',
};
const appointInput = {
  type: 'org_appoint_admin' as const,
  organizationId: ORG,
  userId: USER,
  reason: 'Only admin is unreachable',
  evidence: 'Contract 12',
  currentAuthProof: 'proof',
};

function seedPending(requestedBy = SUPPORT, now = new Date()): SupportRequest {
  const r = SupportRequest.create({
    type: 'hub_force_deregister',
    target: { hubId: HUB },
    reason: 'r',
    evidence: 'e',
    requestedBy,
    now,
  });
  stored.set(r.id, r);
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  stored.clear();
  assigned.clear();
  assigned.set(ADMIN, ['platform_admin']);
  assigned.set(ADMIN2, ['platform_admin']);
  assigned.set(SUPPORT, ['platform_support']);
  assigned.set(SUPPORT2, ['platform_support']);
});

describe('CreateSupportRequestUseCase', () => {
  it('support: pending, audited created, nothing executed; reauth before the transaction', async () => {
    const r = await create.execute(actor(SUPPORT), deregisterInput);
    expect(r.status).toBe('pending');
    expect(r.decidedBy).toBeNull();
    expect(calls).toEqual([
      'verifier.verify',
      'uow.run',
      'repo.insert',
      'platform.request.created',
    ]);
    expect(verifier.verify).toHaveBeenCalledWith(SUPPORT, 'proof');
  });

  it('admin (execute alone): created approved and executed in the same transaction', async () => {
    const r = await create.execute(actor(ADMIN), deregisterInput);
    expect(r.status).toBe('executed');
    expect(r.decidedBy).toBe(ADMIN);
    expect(calls).toEqual([
      'verifier.verify',
      'uow.run',
      'repo.insert',
      'platform.request.created',
      'platform.request.approved',
      'executor.execute',
    ]);
  });

  it('without platform.support.request (finance, customer): 404 before anything', async () => {
    assigned.set(USER, ['platform_finance']);
    await expect(create.execute(actor(USER), deregisterInput)).rejects.toThrow(
      NotFoundError,
    );
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('a staff target is refused (422 staff-cannot-be-appointed) before the reauthentication', async () => {
    await expect(
      create.execute(actor(SUPPORT), { ...appointInput, userId: SUPPORT2 }),
    ).rejects.toMatchObject({ code: 'staff-cannot-be-appointed' });
    await expect(
      create.execute(actor(SUPPORT), { ...appointInput, userId: SUPPORT }),
    ).rejects.toBeInstanceOf(DomainValidationError);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('unknown targets: 404 hub-not-found / organization-not-found / user-not-found', async () => {
    const missing = '0190f3c0-0000-7000-8000-000000000000';
    await expect(
      create.execute(actor(SUPPORT), { ...deregisterInput, hubId: missing }),
    ).rejects.toMatchObject({ code: 'hub-not-found' });
    await expect(
      create.execute(actor(SUPPORT), {
        ...appointInput,
        organizationId: missing,
      }),
    ).rejects.toMatchObject({ code: 'organization-not-found' });
    await expect(
      create.execute(actor(SUPPORT), { ...appointInput, userId: missing }),
    ).rejects.toMatchObject({ code: 'user-not-found' });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('an invalid type × target pair is a 422 before the reauthentication', async () => {
    await expect(
      create.execute(actor(SUPPORT), { ...deregisterInput, userId: USER }),
    ).rejects.toMatchObject({ code: 'support-request-target-invalid' });
    expect(verifier.verify).not.toHaveBeenCalled();
  });
});

describe('DecideSupportRequestUseCase', () => {
  it('approve: locks, approves, audits and executes', async () => {
    const pending = seedPending();
    const r = await decide.approve(actor(ADMIN), pending.id, {
      currentAuthProof: 'proof',
    });
    expect(r.status).toBe('executed');
    expect(r.decidedBy).toBe(ADMIN);
    expect(calls).toEqual([
      'verifier.verify',
      'uow.run',
      'repo.lockById',
      'repo.save:pending',
      'platform.request.approved',
      'executor.execute',
    ]);
  });

  it('reject: rejected with the note, nothing executed', async () => {
    const pending = seedPending();
    const r = await decide.reject(actor(ADMIN), pending.id, {
      note: 'Evidence does not match',
      currentAuthProof: 'proof',
    });
    expect(r.status).toBe('rejected');
    expect(r.decisionNote).toBe('Evidence does not match');
    expect(executor.execute).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe('platform.request.rejected');
  });

  it('expired: the expired state is saved and audited (committed), then 422 support-request-expired', async () => {
    const pending = seedPending(SUPPORT, new Date(Date.now() - 8 * DAY));
    await expect(
      decide.approve(actor(ADMIN), pending.id, { currentAuthProof: 'proof' }),
    ).rejects.toMatchObject({ code: 'support-request-expired' });
    expect(pending.status).toBe('expired');
    expect(calls).toContain('repo.save:expired');
    expect(calls).toContain('platform.request.expired');
    expect(executor.execute).not.toHaveBeenCalled();
    // The error leaves the unit of work only after it resolved (the expiry is committed).
    expect(await uow.run.mock.results[0]!.value).toBeDefined();
  });

  it('self-approval (requester later became admin): 422, nothing saved', async () => {
    const pending = seedPending(SUPPORT);
    assigned.set(SUPPORT, ['platform_admin']);
    await expect(
      decide.approve(actor(SUPPORT), pending.id, { currentAuthProof: 'proof' }),
    ).rejects.toMatchObject({ code: 'self-approval' });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('without platform.support.approve (support): 404 before reading the request', async () => {
    const pending = seedPending(SUPPORT2);
    await expect(
      decide.approve(actor(SUPPORT), pending.id, { currentAuthProof: 'proof' }),
    ).rejects.toThrow(NotFoundError);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('unknown request: 404 support-request-not-found before the reauthentication', async () => {
    await expect(
      decide.approve(actor(ADMIN), '0190f3c0-0000-7000-8000-000000000000', {
        currentAuthProof: 'proof',
      }),
    ).rejects.toMatchObject({ code: 'support-request-not-found' });
    expect(verifier.verify).not.toHaveBeenCalled();
  });
});

describe('ListSupportRequestsUseCase / GetSupportRequestUseCase', () => {
  it('support sees only their own requests; admin sees all', async () => {
    const mine = seedPending(SUPPORT);
    seedPending(SUPPORT2);
    const page = await list.execute(actor(SUPPORT), { limit: 20 });
    expect(page.items.map((r) => r.id)).toEqual([mine.id]);
    expect(repo.list).toHaveBeenLastCalledWith(
      { requestedBy: SUPPORT },
      { cursor: undefined, limit: 20 },
    );
    const all = await list.execute(actor(ADMIN), {
      limit: 20,
      status: 'pending',
    });
    expect(all.items).toHaveLength(2);
    expect(repo.list).toHaveBeenLastCalledWith(
      { status: 'pending' },
      { cursor: undefined, limit: 20 },
    );
  });

  it('a listing expires the due pending requests first (saved + audited)', async () => {
    const old = seedPending(SUPPORT, new Date(Date.now() - 8 * DAY));
    await list.execute(actor(ADMIN), { limit: 20 });
    expect(old.status).toBe('expired');
    expect(calls).toEqual([
      'uow.run',
      'repo.save:expired',
      'platform.request.expired',
    ]);
  });

  it("get: someone else's request is 404 for support; a due one is expired on read", async () => {
    const other = seedPending(SUPPORT2);
    await expect(get.execute(actor(SUPPORT), other.id)).rejects.toMatchObject({
      code: 'support-request-not-found',
    });
    const old = seedPending(SUPPORT, new Date(Date.now() - 8 * DAY));
    const r = await get.execute(actor(SUPPORT), old.id);
    expect(r.status).toBe('expired');
    expect(calls).toContain('platform.request.expired');
  });

  it('finance: 404 on list and get', async () => {
    assigned.set(USER, ['platform_finance']);
    const r = seedPending();
    await expect(list.execute(actor(USER), { limit: 20 })).rejects.toThrow(
      NotFoundError,
    );
    await expect(get.execute(actor(USER), r.id)).rejects.toThrow(NotFoundError);
  });
});
