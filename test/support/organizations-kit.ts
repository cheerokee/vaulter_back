// Mocks for the organizations use cases (unit tests). Repositories are `vi.fn()` driven by a tiny in-memory
// state (members and their roles), so OrganizationAccess and AuditLog run for real on top of them.
import type { UserDirectory } from '../../src/identity/application/user-directory.js';
import type { CurrentAuthProofVerifier } from '../../src/identity/application/current-auth-proof-verifier.js';
import { AuditLog } from '../../src/organizations/application/audit-log.js';
import { OrganizationAccess } from '../../src/organizations/application/organization-access.js';
import type { InvitationTokenCodec } from '../../src/organizations/application/ports/invitation-token-codec.js';
import type { AuditLogRepository } from '../../src/organizations/domain/audit-log.repository.js';
import { Invitation } from '../../src/organizations/domain/invitation.js';
import type { InvitationRepository } from '../../src/organizations/domain/invitation.repository.js';
import type { OrgRoleKey } from '../../src/organizations/domain/membership.js';
import type { MembershipRepository } from '../../src/organizations/domain/membership.repository.js';
import {
  Organization,
  type OrganizationProps,
} from '../../src/organizations/domain/organization.js';
import type { OrganizationRepository } from '../../src/organizations/domain/organization.repository.js';
import { FACTORY_ROLES } from '../../src/organizations/domain/rbac-catalog.js';
import type { RoleAssignmentRepository } from '../../src/organizations/domain/role-assignment.repository.js';
import type { InvitationHooks } from '../../src/shared/application/invitation-hooks.js';
import type { MemberRemovedHooks } from '../../src/shared/application/member-removed-hooks.js';
import type { UnitOfWork } from '../../src/shared/infra/db/unit-of-work.js';

export const NOW = new Date('2026-10-25T12:00:00Z');
export const ORG_ID = '019a1b2c-0000-7000-8000-000000000001';
export const ADMIN = '019a1b2c-0000-7000-8000-0000000000a1';
export const MEMBER = '019a1b2c-0000-7000-8000-0000000000b1';
export const STRANGER = '019a1b2c-0000-7000-8000-0000000000c1';
export const TOKEN = 'A'.repeat(42) + 'E';
export const TOKEN_HASH = 'ab'.repeat(32);

export const actor = (userId: string) => ({ userId, sessionId: 's1' });

export function makeOrganization(
  overrides: Partial<OrganizationProps> = {},
  id = ORG_ID,
): Organization {
  return Organization.restore(
    {
      name: 'Acme',
      isPersonal: false,
      personalOwnerUserId: null,
      hubLinkPolicy: 'any_member_hub',
      plan: 'free',
      recoveryPublicKey: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-02T00:00:00Z'),
      ...overrides,
    },
    id,
  );
}

export function makeInvitation(
  overrides: Partial<{
    email: string | null;
    roleKey: OrgRoleKey;
    status: 'pending' | 'accepted' | 'revoked' | 'expired';
    expiresAt: Date;
    createdBy: string;
  }> = {},
  id = '019a1b2c-0000-7000-8000-0000000000e1',
): Invitation {
  return Invitation.restore(
    {
      organizationId: ORG_ID,
      tokenHash: TOKEN_HASH,
      email: overrides.email ?? null,
      roleKey: overrides.roleKey ?? 'org_member',
      status: overrides.status ?? 'pending',
      expiresAt: overrides.expiresAt ?? new Date('2026-10-30T12:00:00Z'),
      createdBy: overrides.createdBy ?? ADMIN,
      acceptedBy: null,
      acceptedAt: null,
      createdAt: new Date('2026-10-23T12:00:00Z'),
    },
    id,
  );
}

export function makeKit() {
  /** userId -> org role of the active members of ORG_ID. */
  const members = new Map<string, OrgRoleKey>([
    [ADMIN, 'org_admin'],
    [MEMBER, 'org_member'],
  ]);
  let organization: Organization | null = makeOrganization();
  let depth = 0;
  /** Ordered trace of repository calls, tagged with whether they ran inside the unit of work. */
  const trace: string[] = [];
  const tag = (name: string) => trace.push(depth > 0 ? name : `${name}@out`);

  const orgs = {
    create: vi.fn(),
    save: vi.fn(),
    findById: vi.fn(),
    listForUser: vi.fn(),
  };
  const memberships = {
    add: vi.fn(),
    remove: vi.fn(),
    find: vi.fn(),
    lockActive: vi.fn(),
    list: vi.fn(),
    countActive: vi.fn(),
    countAdmins: vi.fn(),
  };
  const roles = {
    assignOrgRole: vi.fn(),
    lockOrgAdmins: vi.fn(),
    orgRoleOf: vi.fn(),
    permissionsOf: vi.fn(),
  };
  const invitations = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    listPending: vi.fn(),
    revoke: vi.fn(),
    revokePendingCreatedBy: vi.fn(),
    markAccepted: vi.fn(),
  };
  const auditRepo = { append: vi.fn() };
  const directory = { findPublicByIds: vi.fn() };
  const verifier = { verify: vi.fn() };
  const codec = { generate: vi.fn(), hash: vi.fn() };
  const memberRemovedHooks = { run: vi.fn() };
  const invitationHooks = { validateAndRecord: vi.fn(), onAccepted: vi.fn() };
  const uow = {
    run: vi.fn(async (work: () => Promise<unknown>) => {
      depth++;
      try {
        return await work();
      } finally {
        depth--;
      }
    }),
  };

  function reset(): void {
    members.clear();
    members.set(ADMIN, 'org_admin');
    members.set(MEMBER, 'org_member');
    organization = makeOrganization();
    trace.length = 0;
    orgs.findById.mockImplementation(async (id: string) => {
      tag('orgs.findById');
      return id === ORG_ID ? organization : null;
    });
    orgs.save.mockImplementation(async () => tag('orgs.save'));
    orgs.create.mockImplementation(async () => tag('orgs.create'));
    memberships.find.mockImplementation(
      async (orgId: string, userId: string) => {
        tag('memberships.find');
        const roleKey = orgId === ORG_ID ? members.get(userId) : undefined;
        return roleKey
          ? { organizationId: orgId, userId, roleKey, joinedAt: NOW }
          : null;
      },
    );
    memberships.lockActive.mockImplementation(
      async (orgId: string, userId: string) => {
        tag('memberships.lockActive');
        return orgId === ORG_ID && members.has(userId);
      },
    );
    memberships.add.mockImplementation(async () => tag('memberships.add'));
    memberships.remove.mockImplementation(async () =>
      tag('memberships.remove'),
    );
    memberships.countActive.mockImplementation(async () => members.size);
    roles.permissionsOf.mockImplementation(
      async (orgId: string, userId: string) => {
        tag('roles.permissionsOf');
        const roleKey = orgId === ORG_ID ? members.get(userId) : undefined;
        return roleKey ? [...FACTORY_ROLES[roleKey]] : [];
      },
    );
    roles.lockOrgAdmins.mockImplementation(async () => {
      tag('roles.lockOrgAdmins');
      return [...members]
        .filter(([, r]) => r === 'org_admin')
        .map(([u]) => u)
        .sort();
    });
    roles.assignOrgRole.mockImplementation(async () =>
      tag('roles.assignOrgRole'),
    );
    invitations.create.mockImplementation(async () =>
      tag('invitations.create'),
    );
    invitations.markAccepted.mockImplementation(async () => {
      tag('invitations.markAccepted');
      return true;
    });
    invitations.revoke.mockResolvedValue(true);
    invitations.revokePendingCreatedBy.mockImplementation(async () => {
      tag('invitations.revokePendingCreatedBy');
      return [];
    });
    memberRemovedHooks.run.mockImplementation(async () =>
      tag('memberRemovedHooks.run'),
    );
    invitationHooks.validateAndRecord.mockImplementation(async () =>
      tag('invitationHooks.validateAndRecord'),
    );
    invitationHooks.onAccepted.mockImplementation(async () =>
      tag('invitationHooks.onAccepted'),
    );
    auditRepo.append.mockImplementation(async () => tag('audit.append'));
    directory.findPublicByIds.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        name: `name-${id.slice(-2)}`,
        email: `${id.slice(-2)}@x.com`,
        publicKey: `pk-${id.slice(-2)}`,
      })),
    );
    verifier.verify.mockResolvedValue(undefined);
    codec.generate.mockReturnValue({ token: TOKEN, tokenHash: TOKEN_HASH });
    codec.hash.mockImplementation((t: string) =>
      t === TOKEN ? TOKEN_HASH : null,
    );
  }

  const access = new OrganizationAccess(
    memberships as unknown as MembershipRepository,
    roles as unknown as RoleAssignmentRepository,
  );
  const audit = new AuditLog(auditRepo as unknown as AuditLogRepository);

  return {
    members,
    trace,
    setOrganization: (org: Organization | null) => {
      organization = org;
    },
    reset,
    mocks: {
      orgs,
      memberships,
      roles,
      invitations,
      auditRepo,
      directory,
      verifier,
      codec,
      uow,
      memberRemovedHooks,
      invitationHooks,
    },
    deps: {
      orgs: orgs as unknown as OrganizationRepository,
      memberships: memberships as unknown as MembershipRepository,
      roles: roles as unknown as RoleAssignmentRepository,
      invitations: invitations as unknown as InvitationRepository,
      directory: directory as unknown as UserDirectory,
      verifier: verifier as unknown as CurrentAuthProofVerifier,
      codec: codec as unknown as InvitationTokenCodec,
      uow: uow as unknown as UnitOfWork,
      memberRemovedHooks: memberRemovedHooks as unknown as MemberRemovedHooks,
      invitationHooks: invitationHooks as unknown as InvitationHooks,
      access,
      audit,
    },
    /** Audit entries recorded so far. */
    audited: () =>
      auditRepo.append.mock.calls.map(
        (c) =>
          c[0] as {
            organizationId: string;
            userId: string | null;
            action: string;
            metadata?: Record<string, unknown>;
          },
      ),
  };
}

export type Kit = ReturnType<typeof makeKit>;
