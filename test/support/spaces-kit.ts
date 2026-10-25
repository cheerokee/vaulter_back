// Mocks for the spaces use cases (unit tests). Repositories are `vi.fn()` driven by a small in-memory state
// (organization members, spaces, space roles, key versions), so SpaceAccess and RecoveryKit run for real on top.
import type { CurrentAuthProofVerifier } from '../../src/identity/application/current-auth-proof-verifier.js';
import type { UserDirectory } from '../../src/identity/application/user-directory.js';
import type { AuditLog } from '../../src/organizations/application/audit-log.js';
import type { OrganizationAccess } from '../../src/organizations/application/organization-access.js';
import type { OrganizationDirectory } from '../../src/organizations/application/organization-directory.js';
import type { MemberRemovedHooks } from '../../src/shared/application/member-removed-hooks.js';
import type { InvitationHooks } from '../../src/shared/application/invitation-hooks.js';
import {
  NotFoundError,
  PermissionDeniedError,
} from '../../src/shared/domain/errors.js';
import type { UnitOfWork } from '../../src/shared/infra/db/unit-of-work.js';
import type { KeyFingerprinter } from '../../src/spaces/application/ports/key-fingerprinter.js';
import { RecoveryKit } from '../../src/spaces/application/recovery-kit.js';
import { SpaceAccess } from '../../src/spaces/application/space-access.js';
import type { PendingGrantRepository } from '../../src/spaces/domain/pending-grant.repository.js';
import type { SpaceGrantRepository } from '../../src/spaces/domain/space-grant.repository.js';
import type { SpaceIntentRepository } from '../../src/spaces/domain/space-intent.repository.js';
import type {
  SpaceKeyRepository,
  SpaceKeyVersion,
} from '../../src/spaces/domain/space-key.repository.js';
import type { SpaceRoleKey } from '../../src/spaces/domain/space-membership.js';
import type { SpaceRoleRepository } from '../../src/spaces/domain/space-role.repository.js';
import { Space } from '../../src/spaces/domain/space.js';
import type { SpaceRepository } from '../../src/spaces/domain/space.repository.js';

export const NOW = new Date('2026-10-25T12:00:00Z');
export const ORG_ID = '019a1b2c-0000-7000-8000-000000000001';
export const OTHER_ORG = '019a1b2c-0000-7000-8000-000000000002';
export const SPACE_ID = '019a1b2c-0000-7000-8000-0000000005a1';
export const OTHER_SPACE = '019a1b2c-0000-7000-8000-0000000005b1';
/** Org admin who is NOT in the space. */
export const ADMIN = '019a1b2c-0000-7000-8000-0000000000a1';
export const MANAGER = '019a1b2c-0000-7000-8000-0000000000d1';
export const EDITOR = '019a1b2c-0000-7000-8000-0000000000d2';
export const READER = '019a1b2c-0000-7000-8000-0000000000d3';
/** Org member outside the space. */
export const OUTSIDER = '019a1b2c-0000-7000-8000-0000000000b1';
/** Not in the organization. */
export const STRANGER = '019a1b2c-0000-7000-8000-0000000000c1';
/** Admin of OTHER_ORG only. */
export const OTHER_ADMIN = '019a1b2c-0000-7000-8000-0000000000f1';
export const INVITATION_ID = '019a1b2c-0000-7000-8000-0000000000e1';

export const KIT_PK = Buffer.alloc(32, 7).toString('base64url');
export const OLD_KIT_PK = Buffer.alloc(32, 8).toString('base64url');
export const fp = (pk: string) => `fp(${pk})`;
export const wk = (n: number) => {
  const b = Buffer.alloc(81, n);
  b[0] = 0x01;
  return b.toString('base64url');
};
export const BAD_WK = Buffer.alloc(81, 0).toString('base64url'); // version byte 0x00
export const PROOF = 'proof';

export const actor = (userId: string) => ({ userId, sessionId: 's1' });

type OrgRole = 'org_admin' | 'org_member';
const ORG_PERMS: Record<OrgRole, string[]> = {
  org_admin: [
    'org.members.manage',
    'org.spaces.create',
    'org.hubs.approve',
    'org.billing',
  ],
  org_member: [],
};

export function makeSpaceKit() {
  /** orgId -> userId -> org role. */
  const orgMembers = new Map<string, Map<string, OrgRole>>();
  const kits = new Map<string, string | null>();
  const spacesById = new Map<string, Space>();
  /** spaceId -> userId -> role. */
  const spaceRoles = new Map<string, Map<string, SpaceRoleKey>>();
  const versionsBySpace = new Map<string, SpaceKeyVersion[]>();
  let depth = 0;
  const trace: string[] = [];
  const tag = (name: string) => trace.push(depth > 0 ? name : `${name}@out`);

  const spaces = {
    create: vi.fn(),
    save: vi.fn(),
    findById: vi.fn(),
    lockForUpdate: vi.fn(),
    listForMember: vi.fn(),
    listAll: vi.fn(),
  };
  const roles = {
    assign: vi.fn(),
    roleOf: vi.fn(),
    remove: vi.fn(),
    activeMemberIds: vi.fn(),
    listMembers: vi.fn(),
    lockSpaceManagers: vi.fn(),
    removeUserInOrg: vi.fn(),
    findOrganizationOfMember: vi.fn(),
    spaceIdsOfUser: vi.fn(),
  };
  const keys = {
    addVersion: vi.fn(),
    versions: vi.fn(),
    setRecoveryWrap: vi.fn(),
  };
  const grants = {
    upsert: vi.fn(),
    forUser: vi.fn(),
    tombstoneUser: vi.fn(),
    tombstoneUserInOrg: vi.fn(),
  };
  const pending = {
    create: vi.fn(),
    findPending: vi.fn(),
    listPending: vi.fn(),
    decline: vi.fn(),
    markGranted: vi.fn(),
    cancelForUser: vi.fn(),
  };
  const intents = { record: vi.fn(), forInvitation: vi.fn() };
  const orgAccess = {
    requireMember: vi.fn(),
    hasPermission: vi.fn(),
    requirePermission: vi.fn(),
  };
  const directory = {
    isActiveMember: vi.fn(),
    recoveryPublicKey: vi.fn(),
    organizationIdsOf: vi.fn(),
  };
  const fingerprinter = { fingerprint: vi.fn() };
  const audit = { record: vi.fn() };
  const users = { findPublicByIds: vi.fn() };
  const verifier = { verify: vi.fn() };
  const memberRemovedHooks = { register: vi.fn(), unregister: vi.fn() };
  const invitationHooks = { register: vi.fn(), unregister: vi.fn() };
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

  const roleOf = (orgId: string, spaceId: string, userId: string) => {
    const space = spacesById.get(spaceId);
    if (!space || space.organizationId !== orgId) return null;
    return spaceRoles.get(spaceId)?.get(userId) ?? null;
  };
  const orgRole = (orgId: string, userId: string) =>
    orgMembers.get(orgId)?.get(userId);
  const spaceIn = (orgId: string, spaceId: string) => {
    const s = spacesById.get(spaceId);
    return s && s.organizationId === orgId ? s : null;
  };
  // A fresh copy, like a new read from the database.
  const reload = (s: Space | null) =>
    s
      ? Space.restore(
          {
            organizationId: s.organizationId,
            name: s.name,
            currentKeyVersion: s.currentKeyVersion,
            keyRotationRequired: s.keyRotationRequired,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
          },
          s.id,
        )
      : null;

  function addSpace(
    id: string,
    orgId: string,
    members: [string, SpaceRoleKey][],
    opts: {
      version?: number;
      fingerprints?: string[];
      rotation?: boolean;
    } = {},
  ): void {
    const version = opts.version ?? 1;
    spacesById.set(
      id,
      Space.restore(
        {
          organizationId: orgId,
          name: 'Manuais',
          currentKeyVersion: version,
          keyRotationRequired: opts.rotation ?? false,
          createdAt: new Date('2026-10-01T00:00:00Z'),
        },
        id,
      ),
    );
    spaceRoles.set(id, new Map(members));
    versionsBySpace.set(
      id,
      Array.from({ length: version }, (_, i) => ({
        id: `${id.slice(-3)}-k${i + 1}`,
        spaceId: id,
        version: i + 1,
        recoveryWrappedKey: wk(90 + i),
        recoveryKeyFingerprint: opts.fingerprints?.[i] ?? fp(KIT_PK),
      })),
    );
  }

  function reset(): void {
    orgMembers.clear();
    orgMembers.set(
      ORG_ID,
      new Map<string, OrgRole>([
        [ADMIN, 'org_admin'],
        [MANAGER, 'org_member'],
        [EDITOR, 'org_member'],
        [READER, 'org_member'],
        [OUTSIDER, 'org_member'],
      ]),
    );
    orgMembers.set(
      OTHER_ORG,
      new Map<string, OrgRole>([[OTHER_ADMIN, 'org_admin']]),
    );
    kits.clear();
    kits.set(ORG_ID, KIT_PK);
    kits.set(OTHER_ORG, null);
    spacesById.clear();
    spaceRoles.clear();
    versionsBySpace.clear();
    addSpace(SPACE_ID, ORG_ID, [
      [MANAGER, 'space_manager'],
      [EDITOR, 'space_editor'],
      [READER, 'space_reader'],
    ]);
    addSpace(OTHER_SPACE, OTHER_ORG, [[OTHER_ADMIN, 'space_manager']]);
    trace.length = 0;

    spaces.create.mockImplementation(async (s: Space) => {
      tag('spaces.create');
      spacesById.set(s.id, s);
      spaceRoles.set(s.id, new Map());
      versionsBySpace.set(s.id, []);
    });
    spaces.save.mockImplementation(async (s: Space) => {
      tag('spaces.save');
      spacesById.set(s.id, reload(s)!);
    });
    spaces.findById.mockImplementation(async (orgId: string, id: string) => {
      tag('spaces.findById');
      return reload(spaceIn(orgId, id));
    });
    spaces.lockForUpdate.mockImplementation(
      async (orgId: string, id: string) => {
        tag('spaces.lockForUpdate');
        return reload(spaceIn(orgId, id));
      },
    );
    roles.findOrganizationOfMember.mockImplementation(
      async (spaceId: string, userId: string) => {
        tag('roles.findOrganizationOfMember');
        const s = spacesById.get(spaceId);
        return s && spaceRoles.get(spaceId)?.has(userId)
          ? s.organizationId
          : null;
      },
    );
    roles.roleOf.mockImplementation(
      async (orgId: string, spaceId: string, userId: string) => {
        tag('roles.roleOf');
        return roleOf(orgId, spaceId, userId);
      },
    );
    roles.assign.mockImplementation(
      async (
        orgId: string,
        spaceId: string,
        userId: string,
        role: SpaceRoleKey,
      ) => {
        tag('roles.assign');
        if (!spaceIn(orgId, spaceId))
          throw new NotFoundError('space-not-found', 'x');
        spaceRoles.get(spaceId)!.set(userId, role);
      },
    );
    roles.remove.mockImplementation(
      async (orgId: string, spaceId: string, userId: string) => {
        tag('roles.remove');
        if (spaceIn(orgId, spaceId)) spaceRoles.get(spaceId)!.delete(userId);
      },
    );
    roles.activeMemberIds.mockImplementation(
      async (orgId: string, spaceId: string) => {
        tag('roles.activeMemberIds');
        return spaceIn(orgId, spaceId)
          ? [...spaceRoles.get(spaceId)!.keys()].sort()
          : [];
      },
    );
    roles.lockSpaceManagers.mockImplementation(
      async (orgId: string, spaceId: string) => {
        tag('roles.lockSpaceManagers');
        return spaceIn(orgId, spaceId)
          ? [...spaceRoles.get(spaceId)!]
              .filter(([, r]) => r === 'space_manager')
              .map(([u]) => u)
              .sort()
          : [];
      },
    );
    roles.listMembers.mockImplementation(
      async (orgId: string, spaceId: string) => ({
        items: spaceIn(orgId, spaceId)
          ? [...spaceRoles.get(spaceId)!].map(([userId, roleKey]) => ({
              userId,
              roleKey,
              joinedAt: NOW,
            }))
          : [],
        nextCursor: null,
      }),
    );
    roles.spaceIdsOfUser.mockImplementation(
      async (orgId: string, userId: string) => {
        tag('roles.spaceIdsOfUser');
        return [...spacesById.values()]
          .filter(
            (s) =>
              s.organizationId === orgId && spaceRoles.get(s.id)!.has(userId),
          )
          .map((s) => s.id)
          .sort();
      },
    );
    roles.removeUserInOrg.mockImplementation(
      async (orgId: string, userId: string) => {
        tag('roles.removeUserInOrg');
        const ids: string[] = [];
        for (const s of spacesById.values()) {
          if (
            s.organizationId === orgId &&
            spaceRoles.get(s.id)!.delete(userId)
          )
            ids.push(s.id);
        }
        return ids.sort();
      },
    );
    keys.versions.mockImplementation(async (orgId: string, spaceId: string) => {
      tag('keys.versions');
      return spaceIn(orgId, spaceId) ? [...versionsBySpace.get(spaceId)!] : [];
    });
    keys.addVersion.mockImplementation(
      async (
        orgId: string,
        spaceId: string,
        version: number,
        rwk: string,
        f: string,
      ) => {
        tag('keys.addVersion');
        const v = {
          id: `${spaceId.slice(-3)}-k${version}`,
          spaceId,
          version,
          recoveryWrappedKey: rwk,
          recoveryKeyFingerprint: f,
        };
        versionsBySpace.get(spaceId)!.push(v);
        return v;
      },
    );
    keys.setRecoveryWrap.mockImplementation(async () =>
      tag('keys.setRecoveryWrap'),
    );
    grants.upsert.mockImplementation(async () => tag('grants.upsert'));
    grants.tombstoneUser.mockImplementation(async () =>
      tag('grants.tombstoneUser'),
    );
    grants.tombstoneUserInOrg.mockImplementation(async () => {
      tag('grants.tombstoneUserInOrg');
      return [];
    });
    grants.forUser.mockResolvedValue([]);
    pending.findPending.mockResolvedValue(null);
    pending.create.mockImplementation(async () => tag('pending.create'));
    pending.markGranted.mockImplementation(async () =>
      tag('pending.markGranted'),
    );
    pending.decline.mockResolvedValue(true);
    pending.cancelForUser.mockResolvedValue(0);
    pending.listPending.mockResolvedValue({ items: [], nextCursor: null });
    intents.record.mockImplementation(async () => tag('intents.record'));
    intents.forInvitation.mockResolvedValue([]);

    orgAccess.requireMember.mockImplementation(
      async (orgId: string, userId: string) => {
        tag('orgAccess.requireMember');
        const r = orgRole(orgId, userId);
        if (!r) throw new NotFoundError('organization-not-found', 'x');
        return { organizationId: orgId, userId, roleKey: r };
      },
    );
    orgAccess.hasPermission.mockImplementation(
      async (orgId: string, userId: string, permission: string) => {
        tag('orgAccess.hasPermission');
        const r = orgRole(orgId, userId);
        return r ? ORG_PERMS[r].includes(permission) : false;
      },
    );
    orgAccess.requirePermission.mockImplementation(
      async (orgId: string, userId: string, permission: string) => {
        tag('orgAccess.requirePermission');
        const r = orgRole(orgId, userId);
        if (!r) throw new NotFoundError('organization-not-found', 'x');
        if (!ORG_PERMS[r].includes(permission)) {
          throw new PermissionDeniedError('permission-denied', 'x');
        }
        return { organizationId: orgId, userId, roleKey: r };
      },
    );
    directory.isActiveMember.mockImplementation(
      async (orgId: string, userId: string) =>
        orgRole(orgId, userId) !== undefined,
    );
    directory.recoveryPublicKey.mockImplementation(
      async (orgId: string) => kits.get(orgId) ?? null,
    );
    directory.organizationIdsOf.mockImplementation(async (userId: string) =>
      [...orgMembers].filter(([, m]) => m.has(userId)).map(([o]) => o),
    );
    fingerprinter.fingerprint.mockImplementation(async (pk: string) => fp(pk));
    audit.record.mockImplementation(async () => tag('audit.record'));
    users.findPublicByIds.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        name: `name-${id.slice(-2)}`,
        email: `${id.slice(-2)}@x.com`,
        publicKey: `pk-${id.slice(-2)}`,
      })),
    );
    verifier.verify.mockImplementation(async () => tag('verifier.verify'));
  }

  const deps = {
    spaces: spaces as unknown as SpaceRepository,
    roles: roles as unknown as SpaceRoleRepository,
    keys: keys as unknown as SpaceKeyRepository,
    grants: grants as unknown as SpaceGrantRepository,
    pending: pending as unknown as PendingGrantRepository,
    intents: intents as unknown as SpaceIntentRepository,
    orgAccess: orgAccess as unknown as OrganizationAccess,
    directory: directory as unknown as OrganizationDirectory,
    fingerprinter: fingerprinter as unknown as KeyFingerprinter,
    audit: audit as unknown as AuditLog,
    users: users as unknown as UserDirectory,
    verifier: verifier as unknown as CurrentAuthProofVerifier,
    uow: uow as unknown as UnitOfWork,
    memberRemovedHooks: memberRemovedHooks as unknown as MemberRemovedHooks,
    invitationHooks: invitationHooks as unknown as InvitationHooks,
  };
  const access = new SpaceAccess(
    deps.spaces,
    deps.roles,
    deps.orgAccess,
    deps.directory,
  );
  const recoveryKit = new RecoveryKit(deps.directory, deps.fingerprinter);

  return {
    trace,
    reset,
    addSpace,
    orgMembers,
    kits,
    spacesById,
    spaceRoles,
    versionsBySpace,
    mocks: {
      spaces,
      roles,
      keys,
      grants,
      pending,
      intents,
      orgAccess,
      directory,
      fingerprinter,
      audit,
      users,
      verifier,
      uow,
      memberRemovedHooks,
      invitationHooks,
    },
    deps: { ...deps, access, recoveryKit },
    audited: () =>
      audit.record.mock.calls.map(
        (c) =>
          c[0] as {
            organizationId: string;
            userId: string | null;
            action: string;
            metadata?: Record<string, unknown>;
          },
      ),
    /** Every argument passed to the audit log, serialized (to prove no wrapped key leaks). */
    auditDump: () => JSON.stringify(audit.record.mock.calls),
  };
}

export type SpaceKit = ReturnType<typeof makeSpaceKit>;
