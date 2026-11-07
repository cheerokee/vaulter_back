import type { HubAdministration } from '../../hubs/application/hub-administration.js';
import type { OrganizationAdministration } from '../../organizations/application/organization-administration.js';
import {
  DomainValidationError,
  NotFoundError,
} from '../../shared/domain/errors.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { PlatformRoleRepository } from '../domain/platform-role.repository.js';
import { SupportRequest } from '../domain/support-request.js';
import type { SupportRequestRepository } from '../domain/support-request.repository.js';
import type { PlatformAudit } from './platform-audit.js';
import { SupportRequestExecutor } from './support-request-executor.js';

const NOW = new Date('2026-11-07T12:00:00Z');
const SUPPORT = '019a1b2c-0000-7000-8000-0000000000b1';
const ADMIN = '019a1b2c-0000-7000-8000-0000000000a1';
const HUB = '019a1b2c-0000-7000-8000-0000000000d1';
const ORG = '019a1b2c-0000-7000-8000-0000000000e1';
const USER = '019a1b2c-0000-7000-8000-0000000000c1';

const calls: string[] = [];
const uow = {
  run: vi.fn(async (work: () => Promise<unknown>) => {
    calls.push('uow.run');
    return work();
  }),
};
const hubs = { deregister: vi.fn() };
const orgs = { appointAdmin: vi.fn() };
const roles = { hasAnyRole: vi.fn(async () => false) };
const repo = { save: vi.fn() };
const audit = { record: vi.fn() };

const executor = new SupportRequestExecutor(
  uow as unknown as UnitOfWork,
  hubs as unknown as HubAdministration,
  orgs as unknown as OrganizationAdministration,
  roles as unknown as PlatformRoleRepository,
  repo as unknown as SupportRequestRepository,
  audit as unknown as PlatformAudit,
);

function approved(
  type: 'hub_force_deregister' | 'org_appoint_admin',
): SupportRequest {
  const r = SupportRequest.create({
    type,
    target:
      type === 'hub_force_deregister'
        ? { hubId: HUB }
        : { organizationId: ORG, userId: USER },
    reason: 'r',
    evidence: 'e',
    requestedBy: SUPPORT,
    now: NOW,
  });
  r.approve(ADMIN, NOW);
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  roles.hasAnyRole.mockResolvedValue(false);
});

describe('SupportRequestExecutor', () => {
  it('forced deregistration: runs in a nested unit of work as the platform, then executed + audit', async () => {
    hubs.deregister.mockImplementation(async () => {
      calls.push('hubs.deregister');
    });
    const r = approved('hub_force_deregister');
    await executor.execute(r, NOW);
    expect(calls).toEqual(['uow.run', 'hubs.deregister']);
    expect(hubs.deregister).toHaveBeenCalledWith(HUB, {
      kind: 'platform',
      supportRequestId: r.id,
    });
    expect(r.status).toBe('executed');
    expect(repo.save).toHaveBeenCalledWith(r);
    expect(audit.record).toHaveBeenCalledWith({
      userId: ADMIN,
      action: 'platform.request.executed',
      result: 'success',
      supportRequestId: r.id,
      targetHubId: HUB,
      metadata: { type: 'hub_force_deregister' },
    });
  });

  it('appointment: checks the target is not staff, then appoints as the platform', async () => {
    const r = approved('org_appoint_admin');
    await executor.execute(r, NOW);
    expect(roles.hasAnyRole).toHaveBeenCalledWith(USER);
    expect(orgs.appointAdmin).toHaveBeenCalledWith(
      ORG,
      USER,
      { kind: 'platform', supportRequestId: r.id },
      NOW,
    );
    expect(r.status).toBe('executed');
  });

  it('a target that became staff after the request: failed staff-cannot-be-appointed, nothing appointed', async () => {
    roles.hasAnyRole.mockResolvedValue(true);
    const r = approved('org_appoint_admin');
    await executor.execute(r, NOW);
    expect(orgs.appointAdmin).not.toHaveBeenCalled();
    expect(r.status).toBe('failed');
    expect(r.failureType).toBe('staff-cannot-be-appointed');
  });

  it('a domain error becomes failed (with its type) without propagating', async () => {
    hubs.deregister.mockRejectedValue(
      new NotFoundError('hub-not-found', 'The hub was not found.'),
    );
    const r = approved('hub_force_deregister');
    await expect(executor.execute(r, NOW)).resolves.toBeUndefined();
    expect(r.status).toBe('failed');
    expect(r.failureType).toBe('hub-not-found');
    expect(repo.save).toHaveBeenCalledWith(r);
    expect(audit.record).toHaveBeenCalledWith({
      userId: ADMIN,
      action: 'platform.request.failed',
      result: 'error',
      supportRequestId: r.id,
      targetHubId: HUB,
      metadata: { type: 'hub_force_deregister', failureType: 'hub-not-found' },
    });
  });

  it('a domain validation error (personal organization) also becomes failed', async () => {
    orgs.appointAdmin.mockRejectedValue(
      new DomainValidationError('personal-organization-protected', 'x'),
    );
    const r = approved('org_appoint_admin');
    await executor.execute(r, NOW);
    expect(r.failureType).toBe('personal-organization-protected');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.request.failed',
        targetOrganizationId: ORG,
        targetUserId: USER,
      }),
    );
  });

  it('any other error propagates, nothing marked or audited', async () => {
    const boom = new Error('connection lost');
    hubs.deregister.mockRejectedValue(boom);
    const r = approved('hub_force_deregister');
    await expect(executor.execute(r, NOW)).rejects.toBe(boom);
    expect(r.status).toBe('pending');
    expect(repo.save).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
