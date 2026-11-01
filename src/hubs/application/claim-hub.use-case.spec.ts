import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import type { AuditLog } from '../../organizations/application/audit-log.js';
import type { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { Enrollment } from '../domain/enrollment.js';
import type { EnrollmentRepository } from '../domain/enrollment.repository.js';
import type { HubOrganizationLink } from '../domain/hub-organization-link.js';
import type { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import type { HubRoleRepository } from '../domain/hub-role.repository.js';
import type { Hub } from '../domain/hub.js';
import type { HubRepository } from '../domain/hub.repository.js';
import { ClaimHubUseCase } from './claim-hub.use-case.js';
import type { HubCodeHasher } from './ports/hub-code-hasher.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const OWNER = '019a0000-0000-7000-8000-0000000000a1';
const PERSONAL_ORG = '019a0000-0000-7000-8000-0000000000b1';
const ENROLLMENT_ID = '019a0000-0000-7000-8000-0000000000e1';
const SIGNING = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
const ENCRYPTION = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';
const actor = { userId: OWNER, sessionId: 's1' };
const INVALID = {
  constructor: DomainValidationError,
  code: 'claim-code-invalid',
};

const calls: string[] = [];
const tag = (name: string) => () => {
  calls.push(name);
};
let inTx = false;
const enrollments = {
  lockPendingByCodeHash: vi.fn(),
  markClaimed: vi.fn(),
};
const hubs = { create: vi.fn() };
const hubRoles = { grantSystemRoles: vi.fn() };
const links = { upsert: vi.fn() };
const codes = { hash: vi.fn(async (c: string) => `hash:${c}`) };
const directory = {
  personalOrganizationIdOf: vi.fn(),
  hubLinkPolicy: vi.fn(),
};
const audit = { record: vi.fn() };
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

const pending = (expiresAt = new Date(NOW.getTime() + 60_000)) =>
  Enrollment.restore(
    {
      signingPublicKey: SIGNING,
      encryptionPublicKey: ENCRYPTION,
      nonce: 'n',
      claimCodeHash: 'hash:12345678',
      expiresAt,
      status: 'pending',
      claimedHubId: null,
    },
    ENROLLMENT_ID,
  );

const useCase = () =>
  new ClaimHubUseCase(
    enrollments as unknown as EnrollmentRepository,
    hubs as unknown as HubRepository,
    hubRoles as unknown as HubRoleRepository,
    links as unknown as HubOrganizationRepository,
    codes as unknown as HubCodeHasher,
    directory as unknown as OrganizationDirectory,
    audit as unknown as AuditLog,
    uow as unknown as UnitOfWork,
  );

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  uow.setContext.mockImplementation(async (ctx: unknown) => {
    calls.push(`ctx:${JSON.stringify(ctx)}`);
  });
  enrollments.lockPendingByCodeHash.mockImplementation(async () => {
    calls.push(`lock:${String(inTx)}`);
    return pending();
  });
  enrollments.markClaimed.mockImplementation(async () => {
    calls.push('markClaimed');
    return true;
  });
  hubs.create.mockImplementation(tag('hubs.create'));
  hubRoles.grantSystemRoles.mockImplementation(tag('grantSystemRoles'));
  links.upsert.mockImplementation(tag('links.upsert'));
  audit.record.mockImplementation(tag('audit'));
  directory.personalOrganizationIdOf.mockResolvedValue(PERSONAL_ORG);
  directory.hubLinkPolicy.mockResolvedValue('any_member_hub');
});
afterEach(() => vi.useRealTimers());

describe('ClaimHubUseCase', () => {
  it('creates the hub, consumes the enrollment, grants roles, links the personal org and audits, in one transaction', async () => {
    const view = await useCase().execute(actor, {
      claimCode: '12345678',
      name: ' Sala ',
    });
    expect(codes.hash).toHaveBeenCalledWith('12345678');
    expect(enrollments.lockPendingByCodeHash).toHaveBeenCalledWith(
      'hash:12345678',
    );
    expect(calls).toEqual([
      `ctx:${JSON.stringify({ userId: OWNER })}`,
      'lock:true',
      'hubs.create',
      'markClaimed',
      'grantSystemRoles',
      'links.upsert',
      'audit',
    ]);
    expect(uow.run).toHaveBeenCalledTimes(1);

    const hub = hubs.create.mock.calls[0]![0] as Hub;
    expect(view).toMatchObject({
      id: hub.id,
      name: 'Sala',
      ownerUserId: OWNER,
      encryptionPublicKey: ENCRYPTION,
    });
    expect(hub.signingPublicKey).toBe(SIGNING);
    expect(enrollments.markClaimed).toHaveBeenCalledWith(
      ENROLLMENT_ID,
      hub.id,
      NOW,
    );
    expect(hubRoles.grantSystemRoles).toHaveBeenCalledWith(hub.id, OWNER);

    const link = links.upsert.mock.calls[0]![0] as HubOrganizationLink;
    expect(link).toMatchObject({
      hubId: hub.id,
      organizationId: PERSONAL_ORG,
      status: 'approved',
      requestedByUserId: OWNER,
      ownerApprovedByUserId: OWNER,
    });
    expect(audit.record).toHaveBeenCalledWith({
      organizationId: PERSONAL_ORG,
      userId: OWNER,
      action: 'hub.claimed',
      metadata: { hubId: hub.id },
    });
    // Nada de código, hash ou chave na auditoria.
    expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(
      /12345678|hash:|AQEB|AgIC/,
    );
  });

  it('refuses a malformed code with the same error, without hashing or opening a transaction', async () => {
    for (const claimCode of [
      '1234567',
      '123456789',
      '1234567a',
      '',
      ' 12345678',
    ]) {
      await expect(
        useCase().execute(actor, { claimCode, name: 'Sala' }),
      ).rejects.toMatchObject(INVALID);
    }
    expect(codes.hash).not.toHaveBeenCalled();
    expect(uow.run).not.toHaveBeenCalled();
  });

  it('checks the name before the code (a name error never says the code is good)', async () => {
    await expect(
      useCase().execute(actor, { claimCode: '12345678', name: '  ' }),
    ).rejects.toMatchObject({ code: 'hub-name-invalid' });
    expect(enrollments.lockPendingByCodeHash).not.toHaveBeenCalled();
  });

  it('gives claim-code-invalid for an unknown or expired code, writing nothing', async () => {
    enrollments.lockPendingByCodeHash.mockResolvedValueOnce(null);
    await expect(
      useCase().execute(actor, { claimCode: '12345678', name: 'Sala' }),
    ).rejects.toMatchObject(INVALID);
    enrollments.lockPendingByCodeHash.mockResolvedValueOnce(pending(NOW));
    await expect(
      useCase().execute(actor, { claimCode: '12345678', name: 'Sala' }),
    ).rejects.toMatchObject(INVALID);
    expect(hubs.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('gives claim-code-invalid when the conditional consume loses (and stops there)', async () => {
    enrollments.markClaimed.mockResolvedValueOnce(false);
    await expect(
      useCase().execute(actor, { claimCode: '12345678', name: 'Sala' }),
    ).rejects.toMatchObject(INVALID);
    expect(hubRoles.grantSystemRoles).not.toHaveBeenCalled();
    expect(links.upsert).not.toHaveBeenCalled();
  });

  it('maps a concurrent claim of the same key (signing-key-in-use) to claim-code-invalid', async () => {
    hubs.create.mockRejectedValueOnce(
      new ConflictError('signing-key-in-use', 'x'),
    );
    await expect(
      useCase().execute(actor, { claimCode: '12345678', name: 'Sala' }),
    ).rejects.toMatchObject(INVALID);
    expect(enrollments.markClaimed).not.toHaveBeenCalled();
  });

  it('fails loudly (not as a caller error) when the owner has no personal organization', async () => {
    directory.personalOrganizationIdOf.mockResolvedValueOnce(null);
    await expect(
      useCase().execute(actor, { claimCode: '12345678', name: 'Sala' }),
    ).rejects.toThrow(/no personal organization/);
    expect(hubs.create).not.toHaveBeenCalled();
  });

  it('follows the personal org policy: admin_approved leaves the link pending', async () => {
    directory.hubLinkPolicy.mockResolvedValueOnce('admin_approved');
    await useCase().execute(actor, { claimCode: '12345678', name: 'Sala' });
    const link = links.upsert.mock.calls[0]![0] as HubOrganizationLink;
    expect(link.status).toBe('pending');
  });
});
