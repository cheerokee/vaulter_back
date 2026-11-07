import type { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import type { UserDirectory } from '../../identity/application/user-directory.js';
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
import type { PlatformAuditLogRepository } from '../domain/platform-audit-log.repository.js';
import type { PlatformRoleRepository } from '../domain/platform-role.repository.js';
import { SupportRequest } from '../domain/support-request.js';
import type { SupportRequestRepository } from '../domain/support-request.repository.js';
import { GetPlatformMeUseCase } from './get-platform-me.use-case.js';
import { GrantPlatformRoleUseCase } from './grant-platform-role.use-case.js';
import { ListStaffUseCase } from './list-staff.use-case.js';
import { PlatformAccess } from './platform-access.js';
import { PlatformAudit } from './platform-audit.js';
import { RevokePlatformRoleUseCase } from './revoke-platform-role.use-case.js';

const ADMIN = '019a1b2c-0000-7000-8000-0000000000a1';
const ADMIN2 = '019a1b2c-0000-7000-8000-0000000000a2';
const SUPPORT = '019a1b2c-0000-7000-8000-0000000000b1';
const CUSTOMER = '019a1b2c-0000-7000-8000-0000000000c1';
const MISSING = '019a1b2c-0000-7000-8000-0000000000ff';
const PROOF = 'proof';
const actor = (userId: string) => ({ userId, sessionId: 's1' });

// Estado em memória das atribuições; os mocks do repositório leem dele, então PlatformAccess roda de verdade.
const assigned = new Map<string, Set<PlatformRoleKey>>();
const calls: string[] = [];
const has = (u: string, r: PlatformRoleKey) => assigned.get(u)?.has(r) ?? false;

const roles = {
  permissionsOf: vi.fn(async (u: string) => {
    const set = new Set<PlatformPermission>();
    for (const r of assigned.get(u) ?? [])
      PLATFORM_ROLES[r].permissions.forEach((p) => set.add(p));
    calls.push('roles.permissionsOf');
    return [...set].sort();
  }),
  rolesOf: vi.fn(async (u: string) => [...(assigned.get(u) ?? [])].sort()),
  hasAnyRole: vi.fn(async (u: string) => (assigned.get(u)?.size ?? 0) > 0),
  grant: vi.fn(async (u: string, r: PlatformRoleKey) => {
    calls.push('roles.grant');
    if (has(u, r)) return false;
    assigned.set(u, new Set([...(assigned.get(u) ?? []), r]));
    return true;
  }),
  revoke: vi.fn(async (u: string, r: PlatformRoleKey) => {
    calls.push('roles.revoke');
    if (!has(u, r)) return false;
    assigned.get(u)!.delete(r);
    return true;
  }),
  lockAdmins: vi.fn(async () => {
    calls.push('roles.lockAdmins');
    return [...assigned]
      .filter(([, s]) => s.has('platform_admin'))
      .map(([u]) => u)
      .sort();
  }),
  listStaff: vi.fn(),
};
const auditRepo = { append: vi.fn() };
const verifier = {
  verify: vi.fn(async () => {
    calls.push('verifier.verify');
  }),
};
const directory = {
  findPublicByIds: vi.fn(async (ids: string[]) =>
    ids
      .filter((id) => id !== MISSING)
      .map((id) => ({
        id,
        name: `name-${id.slice(-2)}`,
        email: `${id.slice(-2)}@example.com`,
        publicKey: 'pk',
      })),
  ),
};
let inUow = false;
const uow = {
  run: vi.fn(async (work: () => Promise<unknown>) => {
    calls.push('uow.run');
    inUow = true;
    try {
      return await work();
    } finally {
      inUow = false;
    }
  }),
};

const repo = roles as unknown as PlatformRoleRepository;
const access = new PlatformAccess(repo);
const audit = new PlatformAudit(
  auditRepo as unknown as PlatformAuditLogRepository,
);
const deps = [
  access,
  repo,
  audit,
  verifier as unknown as CurrentAuthProofVerifier,
  directory as unknown as UserDirectory,
  uow as unknown as UnitOfWork,
] as const;
const pendingOf = new Map<string, SupportRequest[]>();
const requests = {
  lockPendingOf: vi.fn(async (u: string) => {
    calls.push('requests.lockPendingOf');
    return pendingOf.get(u) ?? [];
  }),
  save: vi.fn(async (r: SupportRequest) => {
    calls.push(`requests.save:${r.status}`);
  }),
};
const grant = new GrantPlatformRoleUseCase(...deps);
const revoke = new RevokePlatformRoleUseCase(
  ...deps,
  requests as unknown as SupportRequestRepository,
);
const me = new GetPlatformMeUseCase(repo);
const listStaff = new ListStaffUseCase(
  access,
  repo,
  directory as unknown as UserDirectory,
);

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  assigned.clear();
  pendingOf.clear();
  assigned.set(ADMIN, new Set(['platform_admin']));
  assigned.set(SUPPORT, new Set(['platform_support']));
  auditRepo.append.mockImplementation(async () => {
    expect(inUow).toBe(true);
  });
});

describe('RevokePlatformRoleUseCase', () => {
  const pendingBy = (requestedBy: string, now = new Date()) =>
    SupportRequest.create({
      type: 'hub_force_deregister',
      target: { hubId: '019a1b2c-0000-7000-8000-0000000000d1' },
      reason: 'r',
      evidence: 'e',
      requestedBy,
      now,
    });

  it('losing platform.support.request rejects the pending requests of the target in the same transaction', async () => {
    const pending = pendingBy(SUPPORT);
    const due = pendingBy(SUPPORT, new Date(Date.now() - 8 * 86_400_000));
    pendingOf.set(SUPPORT, [pending, due]);
    await revoke.execute(actor(ADMIN), SUPPORT, 'platform_support', {
      currentAuthProof: PROOF,
    });
    expect(requests.lockPendingOf).toHaveBeenCalledWith(SUPPORT);
    expect(pending.status).toBe('rejected');
    expect(pending.decisionNote).toBe('requester_lost_permission');
    expect(due.status).toBe('expired');
    expect(auditRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        action: 'platform.request.rejected',
        supportRequestId: pending.id,
        metadata: {
          type: 'hub_force_deregister',
          reason: 'requester_lost_permission',
        },
      }),
    );
    expect(auditRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        action: 'platform.request.expired',
        supportRequestId: due.id,
      }),
    );
    // Lock order: admins (FOR UPDATE), then the revocation, then the target's requests.
    const inTx = calls.slice(calls.indexOf('uow.run'));
    expect(inTx.indexOf('roles.lockAdmins')).toBeLessThan(
      inTx.indexOf('requests.lockPendingOf'),
    );
    expect(inTx.indexOf('roles.revoke')).toBeLessThan(
      inTx.indexOf('requests.lockPendingOf'),
    );
    expect(calls).toContain('requests.save:rejected');
  });

  it('keeping platform.support.request (another role still grants it) leaves the requests alone', async () => {
    assigned.set(ADMIN2, new Set(['platform_admin', 'platform_support']));
    pendingOf.set(ADMIN2, [pendingBy(ADMIN2)]);
    await revoke.execute(actor(ADMIN), ADMIN2, 'platform_support', {
      currentAuthProof: PROOF,
    });
    expect(requests.lockPendingOf).not.toHaveBeenCalled();
  });

  it('the last admin cannot lose platform_admin -> 422 last-platform-admin, nothing written or audited', async () => {
    const err = await revoke
      .execute(actor(ADMIN), ADMIN, 'platform_admin', {
        currentAuthProof: PROOF,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainValidationError);
    expect((err as DomainValidationError).code).toBe('last-platform-admin');
    expect(roles.revoke).not.toHaveBeenCalled();
    expect(auditRepo.append).not.toHaveBeenCalled();
    expect(has(ADMIN, 'platform_admin')).toBe(true);
  });

  it('with two admins one revokes the other: ok, audited inside the transaction, decided under lockAdmins', async () => {
    assigned.set(ADMIN2, new Set(['platform_admin']));
    await revoke.execute(actor(ADMIN), ADMIN2, 'platform_admin', {
      currentAuthProof: PROOF,
    });
    expect(has(ADMIN2, 'platform_admin')).toBe(false);
    expect(auditRepo.append).toHaveBeenCalledWith({
      userId: ADMIN,
      action: 'platform.role.revoked',
      result: 'success',
      targetUserId: ADMIN2,
      metadata: { roleKey: 'platform_admin' },
    });
    // Reautenticação fora da transação; lock antes de reconferir a permissão e de gravar.
    expect(calls.indexOf('verifier.verify')).toBeLessThan(
      calls.indexOf('uow.run'),
    );
    const inTx = calls.slice(calls.indexOf('uow.run'));
    expect(inTx.indexOf('roles.lockAdmins')).toBeLessThan(
      inTx.indexOf('roles.permissionsOf'),
    );
    expect(inTx.indexOf('roles.lockAdmins')).toBeLessThan(
      inTx.indexOf('roles.revoke'),
    );
  });

  it('with two admins an admin may drop their own platform_admin', async () => {
    assigned.set(ADMIN2, new Set(['platform_admin']));
    await revoke.execute(actor(ADMIN), ADMIN, 'platform_admin', {
      currentAuthProof: PROOF,
    });
    expect(has(ADMIN, 'platform_admin')).toBe(false);
  });

  it('is idempotent: revoking a role the user does not have succeeds without audit', async () => {
    await revoke.execute(actor(ADMIN), CUSTOMER, 'platform_support', {
      currentAuthProof: PROOF,
    });
    expect(auditRepo.append).not.toHaveBeenCalled();
  });

  it('without platform.roles.manage -> 404 not-found before the reauthentication', async () => {
    await expect(
      revoke.execute(actor(SUPPORT), SUPPORT, 'platform_support', {
        currentAuthProof: PROOF,
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('unknown target user -> 404 user-not-found', async () => {
    const err = await revoke
      .execute(actor(ADMIN), MISSING, 'platform_support', {
        currentAuthProof: PROOF,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).code).toBe('user-not-found');
  });
});

describe('GrantPlatformRoleUseCase', () => {
  it('gives the role, audited, reauthenticated outside the transaction', async () => {
    await grant.execute(actor(ADMIN), CUSTOMER, 'platform_support', {
      currentAuthProof: PROOF,
    });
    expect(has(CUSTOMER, 'platform_support')).toBe(true);
    expect(verifier.verify).toHaveBeenCalledWith(ADMIN, PROOF);
    expect(calls.indexOf('verifier.verify')).toBeLessThan(
      calls.indexOf('uow.run'),
    );
    expect(auditRepo.append).toHaveBeenCalledWith({
      userId: ADMIN,
      action: 'platform.role.granted',
      result: 'success',
      targetUserId: CUSTOMER,
      metadata: { roleKey: 'platform_support' },
    });
  });

  it('is idempotent: granting a role the user already has succeeds without audit', async () => {
    await grant.execute(actor(ADMIN), SUPPORT, 'platform_support', {
      currentAuthProof: PROOF,
    });
    expect(auditRepo.append).not.toHaveBeenCalled();
  });

  it('a reauthentication failure stops before any write', async () => {
    verifier.verify.mockRejectedValueOnce(
      new DomainValidationError('current-auth-proof-invalid', 'x'),
    );
    await expect(
      grant.execute(actor(ADMIN), CUSTOMER, 'platform_support', {
        currentAuthProof: PROOF,
      }),
    ).rejects.toMatchObject({ code: 'current-auth-proof-invalid' });
    expect(uow.run).not.toHaveBeenCalled();
    expect(has(CUSTOMER, 'platform_support')).toBe(false);
  });

  it('loses the permission between the check and the transaction -> 404, nothing written', async () => {
    verifier.verify.mockImplementationOnce(async () => {
      assigned.get(ADMIN)!.delete('platform_admin');
    });
    await expect(
      grant.execute(actor(ADMIN), CUSTOMER, 'platform_support', {
        currentAuthProof: PROOF,
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(roles.grant).not.toHaveBeenCalled();
  });
});

describe('GetPlatformMeUseCase', () => {
  it('returns roles and permissions of a staff member', async () => {
    await expect(me.execute(actor(SUPPORT))).resolves.toEqual({
      roles: ['platform_support'],
      permissions: ['platform.audit.read', 'platform.support.request'],
    });
  });

  it('a finance member (no permissions) still sees their role', async () => {
    assigned.set(CUSTOMER, new Set(['platform_finance']));
    await expect(me.execute(actor(CUSTOMER))).resolves.toEqual({
      roles: ['platform_finance'],
      permissions: [],
    });
  });

  it('no role -> 404 not-found', async () => {
    await expect(me.execute(actor(CUSTOMER))).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});

describe('ListStaffUseCase', () => {
  it('requires platform.roles.manage (404 otherwise) and joins names and e-mails', async () => {
    await expect(
      listStaff.execute(actor(SUPPORT), { limit: 20 }),
    ).rejects.toMatchObject({ code: 'not-found' });
    roles.listStaff.mockResolvedValue({
      items: [
        { userId: ADMIN, roles: ['platform_admin'] },
        { userId: SUPPORT, roles: ['platform_support'] },
      ],
      nextCursor: 'next',
    });
    await expect(
      listStaff.execute(actor(ADMIN), { limit: 20 }),
    ).resolves.toEqual({
      items: [
        {
          userId: ADMIN,
          name: 'name-a1',
          email: 'a1@example.com',
          roles: ['platform_admin'],
        },
        {
          userId: SUPPORT,
          name: 'name-b1',
          email: 'b1@example.com',
          roles: ['platform_support'],
        },
      ],
      nextCursor: 'next',
    });
  });
});
