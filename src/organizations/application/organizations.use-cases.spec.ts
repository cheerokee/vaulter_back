import {
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import { Organization } from '../domain/organization.js';
import {
  ADMIN,
  MEMBER,
  NOW,
  ORG_ID,
  STRANGER,
  actor,
  makeKit,
  makeOrganization,
} from '../../../test/support/organizations-kit.js';
import { CreateOrganizationUseCase } from './create-organization.use-case.js';
import { GetOrganizationUseCase } from './get-organization.use-case.js';
import { ListMyOrganizationsUseCase } from './list-my-organizations.use-case.js';
import { SetRecoveryKeyUseCase } from './set-recovery-key.use-case.js';
import { UpdateOrganizationUseCase } from './update-organization.use-case.js';

const kit = makeKit();
const d = kit.deps;
const m = kit.mocks;
const KEY = Buffer.alloc(32, 7).toString('base64url');
const KEY2 = Buffer.alloc(32, 8).toString('base64url');
const PROOF = Buffer.alloc(32, 9).toString('base64url');

beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('CreateOrganizationUseCase', () => {
  const useCase = () =>
    new CreateOrganizationUseCase(
      d.orgs,
      d.memberships,
      d.roles,
      d.audit,
      d.uow,
    );

  it('creates the organization, makes the author org_admin and audits, all in the unit of work', async () => {
    const view = await useCase().execute(actor(STRANGER), { name: ' Studio ' });
    const created = m.orgs.create.mock.calls[0]![0] as Organization;
    expect(created.name).toBe('Studio');
    expect(created.isPersonal).toBe(false);
    expect(m.memberships.add).toHaveBeenCalledWith(created.id, STRANGER, NOW);
    expect(m.roles.assignOrgRole).toHaveBeenCalledWith(
      created.id,
      STRANGER,
      'org_admin',
      STRANGER,
    );
    expect(kit.audited()).toEqual([
      {
        organizationId: created.id,
        userId: STRANGER,
        action: 'organization.created',
      },
    ]);
    expect(kit.trace).toEqual([
      'orgs.create',
      'memberships.add',
      'roles.assignOrgRole',
      'audit.append',
    ]);
    expect(view).toEqual({
      id: created.id,
      name: 'Studio',
      isPersonal: false,
      hubLinkPolicy: 'any_member_hub',
      plan: 'free',
      recoveryPublicKey: null,
      roleKey: 'org_admin',
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('rejects an invalid name before writing', async () => {
    await expect(
      useCase().execute(actor(STRANGER), { name: '  ' }),
    ).rejects.toMatchObject({ code: 'organization-name-invalid' });
    expect(m.orgs.create).not.toHaveBeenCalled();
  });

  it('createPersonal creates a personal organization owned by the user', async () => {
    const org = await useCase().createPersonal({
      ownerId: STRANGER,
      name: 'Ana',
      now: NOW,
    });
    expect(org.isPersonal).toBe(true);
    expect(org.personalOwnerUserId).toBe(STRANGER);
    expect(m.memberships.add).toHaveBeenCalledWith(org.id, STRANGER, NOW);
    expect(m.roles.assignOrgRole).toHaveBeenCalledWith(
      org.id,
      STRANGER,
      'org_admin',
      STRANGER,
    );
    expect(kit.audited()).toEqual([
      {
        organizationId: org.id,
        userId: STRANGER,
        action: 'organization.created',
        metadata: { personal: true },
      },
    ]);
    expect(kit.trace.every((t) => !t.endsWith('@out'))).toBe(true);
  });
});

describe('ListMyOrganizationsUseCase', () => {
  it('lists the organizations of the author with their role', async () => {
    const org = makeOrganization();
    m.orgs.listForUser.mockResolvedValue({
      items: [{ organization: org, roleKey: 'org_member' }],
      nextCursor: 'c1',
    });
    const page = { limit: 5 };
    const out = await new ListMyOrganizationsUseCase(d.orgs).execute(
      actor(MEMBER),
      page,
    );
    expect(m.orgs.listForUser).toHaveBeenCalledWith(MEMBER, page);
    expect(out).toEqual({
      items: [
        expect.objectContaining({
          id: ORG_ID,
          name: 'Acme',
          roleKey: 'org_member',
        }),
      ],
      nextCursor: 'c1',
    });
  });
});

describe('GetOrganizationUseCase', () => {
  const useCase = () => new GetOrganizationUseCase(d.access, d.orgs);

  it('returns the organization with the role of a member', async () => {
    const out = await useCase().execute(actor(MEMBER), ORG_ID);
    expect(out).toMatchObject({ id: ORG_ID, roleKey: 'org_member' });
  });

  it('404 for a non-member', async () => {
    await expect(
      useCase().execute(actor(STRANGER), ORG_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(m.orgs.findById).not.toHaveBeenCalled();
  });
});

describe('UpdateOrganizationUseCase', () => {
  const useCase = () =>
    new UpdateOrganizationUseCase(d.access, d.orgs, d.audit, d.uow);

  it('renames and changes the hub link policy, then audits the changed fields', async () => {
    const out = await useCase().execute(actor(ADMIN), ORG_ID, {
      name: 'New',
      hubLinkPolicy: 'admin_approved',
    });
    const saved = m.orgs.save.mock.calls[0]![0] as Organization;
    expect(saved.name).toBe('New');
    expect(saved.hubLinkPolicy).toBe('admin_approved');
    expect(out).toMatchObject({ name: 'New', hubLinkPolicy: 'admin_approved' });
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'organization.updated',
        metadata: { fields: ['name', 'hubLinkPolicy'] },
      },
    ]);
    expect(kit.trace.every((t) => !t.endsWith('@out'))).toBe(true);
  });

  it('403 for a member without org.members.manage', async () => {
    await expect(
      useCase().execute(actor(MEMBER), ORG_ID, { name: 'x' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(m.orgs.save).not.toHaveBeenCalled();
    expect(m.auditRepo.append).not.toHaveBeenCalled();
  });

  it('404 for a non-member', async () => {
    await expect(
      useCase().execute(actor(STRANGER), ORG_ID, { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects an invalid policy (domain rule)', async () => {
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, {
        hubLinkPolicy: 'whatever' as never,
      }),
    ).rejects.toMatchObject({ code: 'hub-link-policy-invalid' });
    expect(m.orgs.save).not.toHaveBeenCalled();
  });
});

describe('SetRecoveryKeyUseCase', () => {
  const useCase = () =>
    new SetRecoveryKeyUseCase(d.verifier, d.access, d.orgs, d.audit, d.uow);

  it('verifies the proof outside the unit of work, then registers the first key and audits registered (no key in metadata)', async () => {
    m.verifier.verify.mockImplementation(async () => {
      expect(m.uow.run).not.toHaveBeenCalled();
    });
    const out = await useCase().execute(actor(ADMIN), ORG_ID, {
      recoveryPublicKey: KEY,
      currentAuthProof: PROOF,
    });
    expect(m.verifier.verify).toHaveBeenCalledWith(ADMIN, PROOF);
    const saved = m.orgs.save.mock.calls[0]![0] as Organization;
    expect(saved.recoveryPublicKey).toBe(KEY);
    expect(out.recoveryPublicKey).toBe(KEY);
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'organization.recovery_key.registered',
      },
    ]);
    expect(JSON.stringify(kit.audited())).not.toContain(KEY);
    expect(JSON.stringify(kit.audited())).not.toContain(PROOF);
  });

  it('audits replaced when a key already exists', async () => {
    kit.setOrganization(makeOrganization({ recoveryPublicKey: KEY }));
    await useCase().execute(actor(ADMIN), ORG_ID, {
      recoveryPublicKey: KEY2,
      currentAuthProof: PROOF,
    });
    expect(kit.audited().map((a) => a.action)).toEqual([
      'organization.recovery_key.replaced',
    ]);
  });

  it('a wrong proof stops everything (current-auth-proof-invalid)', async () => {
    m.verifier.verify.mockRejectedValue(
      new DomainValidationError('current-auth-proof-invalid', 'x'),
    );
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, {
        recoveryPublicKey: KEY,
        currentAuthProof: PROOF,
      }),
    ).rejects.toMatchObject({ code: 'current-auth-proof-invalid' });
    expect(m.orgs.save).not.toHaveBeenCalled();
    expect(m.auditRepo.append).not.toHaveBeenCalled();
  });

  it('a malformed key is rejected before verifying the proof', async () => {
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, {
        recoveryPublicKey: 'short',
        currentAuthProof: PROOF,
      }),
    ).rejects.toMatchObject({ code: 'recovery-public-key-invalid' });
    expect(m.verifier.verify).not.toHaveBeenCalled();
  });

  it('403 for a member and 404 for a non-member, without spending the proof verification', async () => {
    const input = { recoveryPublicKey: KEY, currentAuthProof: PROOF };
    await expect(
      useCase().execute(actor(MEMBER), ORG_ID, input),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      useCase().execute(actor(STRANGER), ORG_ID, input),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(m.verifier.verify).not.toHaveBeenCalled();
    expect(m.orgs.save).not.toHaveBeenCalled();
  });
});
