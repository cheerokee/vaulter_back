import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User } from '../../src/identity/domain/user.js';
import { UserRepository } from '../../src/identity/domain/user.repository.js';
import { DEFAULT_KDF_PARAMS } from '../../src/identity/domain/kdf-params.js';
import { Invitation } from '../../src/organizations/domain/invitation.js';
import { InvitationRepository } from '../../src/organizations/domain/invitation.repository.js';
import { MembershipRepository } from '../../src/organizations/domain/membership.repository.js';
import type { OrgRoleKey } from '../../src/organizations/domain/membership.js';
import { Organization } from '../../src/organizations/domain/organization.js';
import { OrganizationRepository } from '../../src/organizations/domain/organization.repository.js';
import { RoleAssignmentRepository } from '../../src/organizations/domain/role-assignment.repository.js';
import { NotFoundError } from '../../src/shared/domain/errors.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  UnitOfWork,
  runWithContext,
} from '../../src/shared/infra/db/unit-of-work.js';
import { PendingGrantRepository } from '../../src/spaces/domain/pending-grant.repository.js';
import { SpaceGrantRepository } from '../../src/spaces/domain/space-grant.repository.js';
import { SpaceIntentRepository } from '../../src/spaces/domain/space-intent.repository.js';
import { SpaceKeyRepository } from '../../src/spaces/domain/space-key.repository.js';
import type { SpaceRoleKey } from '../../src/spaces/domain/space-membership.js';
import { SpaceRoleRepository } from '../../src/spaces/domain/space-role.repository.js';
import { Space } from '../../src/spaces/domain/space.js';
import { SpaceRepository } from '../../src/spaces/domain/space.repository.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';

const b64 = (n: number, first?: number) => {
  const b = Buffer.alloc(n, 0xab);
  if (first !== undefined) b[0] = first;
  return b.toString('base64url');
};
const FP_OLD = 'a'.repeat(64);
const FP_NEW = 'b'.repeat(64);
const wrapped = (tag: string) => `wk-${tag}`;

const now = new Date('2026-10-25T12:00:00.000Z');
const NOT_FOUND = { constructor: NotFoundError, code: 'space-not-found' };

const SPACE_TABLES = [
  'spaces',
  'space_keys',
  'space_key_grants',
  'space_pending_grants',
  'invitation_space_intents',
] as const;

describe('spaces repositories (e2e, app role)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let admin: DataSource;
  let uow: UnitOfWork;
  let users: UserRepository;
  let orgs: OrganizationRepository;
  let members: MembershipRepository;
  let orgRoles: RoleAssignmentRepository;
  let invitations: InvitationRepository;
  let spaces: SpaceRepository;
  let keys: SpaceKeyRepository;
  let grants: SpaceGrantRepository;
  let spaceRoles: SpaceRoleRepository;
  let pending: PendingGrantRepository;
  let intents: SpaceIntentRepository;

  const makeUser = async (email: string): Promise<string> => {
    const user = User.register({
      name: email.split('@')[0]!,
      email,
      authHash: '$argon2id$v=19$m=19456,t=2,p=1$fake',
      kdfSalt: b64(16),
      kdfParams: { ...DEFAULT_KDF_PARAMS },
      publicKey: b64(32),
      encryptedPrivateKey: b64(73, 0x01),
      now,
    });
    await users.create(user);
    return user.id;
  };

  const makeOrg = async (
    name: string,
    admins: string[],
    plainMembers: string[] = [],
  ): Promise<Organization> => {
    const org = Organization.create({ name, now });
    await uow.run(async () => {
      await orgs.create(org);
      const add = async (userId: string, role: OrgRoleKey) => {
        await members.add(org.id, userId, now);
        await orgRoles.assignOrgRole(org.id, userId, role, null);
      };
      for (const u of admins) await add(u, 'org_admin');
      for (const u of plainMembers) await add(u, 'org_member');
    });
    return org;
  };

  // Espaço com a versão 1, a cópia de quem criou e quem criou como Gestor; `others` entram com cópia e papel.
  const makeSpace = async (
    orgId: string,
    creator: string,
    others: [string, SpaceRoleKey][] = [],
    name = 'Manuais',
  ): Promise<{ space: Space; keyId: string }> => {
    const space = Space.create({ organizationId: orgId, name, now });
    const keyId = await uow.run(async () => {
      await spaces.create(space);
      const key = await keys.addVersion(
        orgId,
        space.id,
        1,
        wrapped('recovery-1'),
        FP_OLD,
      );
      await grants.upsert(orgId, key.id, creator, wrapped(`${creator}-1`));
      await spaceRoles.assign(orgId, space.id, creator, 'space_manager', null);
      for (const [userId, role] of others) {
        await grants.upsert(orgId, key.id, userId, wrapped(`${userId}-1`));
        await spaceRoles.assign(orgId, space.id, userId, role, creator);
      }
      return key.id;
    });
    return { space, keyId };
  };

  const issue = (orgId: string, createdBy: string) =>
    Invitation.issue({
      organizationId: orgId,
      roleKey: 'org_member',
      createdBy,
      tokenHash: newId().replaceAll('-', '') + newId().replaceAll('-', ''),
      now,
    });

  // SQL direto pelo papel de runtime, com o contexto dado (ou nenhum).
  const asApp = (
    ctx: { organizationId?: string; userId?: string },
    sql: string,
    params: unknown[] = [],
  ): Promise<Record<string, unknown>[]> =>
    runWithContext(ds, ctx, (m) => m.query(sql, params));

  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    return { promise, release };
  };

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    admin = await adminDataSource();
    uow = app.get(UnitOfWork);
    users = app.get(UserRepository, { strict: false });
    orgs = app.get(OrganizationRepository, { strict: false });
    members = app.get(MembershipRepository, { strict: false });
    orgRoles = app.get(RoleAssignmentRepository, { strict: false });
    invitations = app.get(InvitationRepository, { strict: false });
    spaces = app.get(SpaceRepository, { strict: false });
    keys = app.get(SpaceKeyRepository, { strict: false });
    grants = app.get(SpaceGrantRepository, { strict: false });
    spaceRoles = app.get(SpaceRoleRepository, { strict: false });
    pending = app.get(PendingGrantRepository, { strict: false });
    intents = app.get(SpaceIntentRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  describe('row-level security', () => {
    // Organização A com espaço, chave, cópia, papel de espaço, pendência e intenção; Bob é só da B.
    const seedA = async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const cid = await makeUser('cid@x.com');
      const orgA = await makeOrg('A', [ana], [cid]);
      const orgB = await makeOrg('B', [bob]);
      const { space, keyId } = await makeSpace(orgA.id, ana);
      const inv = issue(orgA.id, ana);
      await invitations.create(inv);
      await intents.record(orgA.id, inv.id, [
        { spaceId: space.id, roleKey: 'space_reader' },
      ]);
      await pending.create(orgA.id, {
        id: newId(),
        spaceId: space.id,
        userId: cid,
        roleKey: 'space_editor',
        invitationId: inv.id,
        requestedByUserId: ana,
      });
      return { ana, bob, cid, orgA, orgB, space, keyId, inv };
    };

    it('another organization (or no context) sees no space rows, even with direct SQL', async () => {
      const { ana, bob, orgA, orgB, space, inv } = await seedA();
      for (const ctx of [{}, { userId: bob }, { organizationId: orgB.id }]) {
        for (const t of SPACE_TABLES) {
          expect(
            await asApp(ctx, `SELECT 1 FROM ${t} WHERE organization_id = $1`, [
              orgA.id,
            ]),
          ).toEqual([]);
        }
        expect(
          await asApp(
            ctx,
            `SELECT 1 FROM role_assignments WHERE scope_type = 'space' AND space_id = $1`,
            [space.id],
          ),
        ).toEqual([]);
      }
      // Pelos repositórios, com o id válido de lá e o contexto da B.
      expect(await spaces.findById(orgB.id, space.id)).toBeNull();
      expect(await keys.versions(orgB.id, space.id)).toEqual([]);
      expect(await grants.forUser(orgB.id, space.id, ana)).toEqual([]);
      expect(await spaceRoles.roleOf(orgB.id, space.id, ana)).toBeNull();
      expect(await spaceRoles.activeMemberIds(orgB.id, space.id)).toEqual([]);
      expect(
        await pending.listPending(orgB.id, space.id, { limit: 10 }),
      ).toEqual({ items: [], nextCursor: null });
      expect(await intents.forInvitation(orgB.id, inv.id)).toEqual([]);
      expect((await spaces.listAll(orgB.id, { limit: 10 })).items).toEqual([]);
      // Os da A continuam lá.
      expect((await spaces.findById(orgA.id, space.id))?.name).toBe('Manuais');
    });

    it('another organization cannot write into or point at the spaces of A', async () => {
      const { ana, bob, orgA, orgB, space, keyId } = await seedA();
      for (const [sql, params] of [
        [
          `INSERT INTO spaces (organization_id, name) VALUES ($1, 'x')`,
          [orgA.id],
        ],
        [
          `INSERT INTO space_keys (organization_id, space_id, version, recovery_wrapped_key, recovery_key_fingerprint) VALUES ($1, $2, 9, 'x', 'f')`,
          [orgA.id, space.id],
        ],
        [
          `INSERT INTO space_key_grants (organization_id, space_key_id, user_id, wrapped_key) VALUES ($1, $2, $3, 'x')`,
          [orgA.id, keyId, bob],
        ],
      ] as const) {
        await expect(
          asApp({ organizationId: orgB.id }, sql, [...params]),
        ).rejects.toMatchObject({ code: '42501' });
      }
      // UPDATE no contexto da B não alcança nada da A.
      await asApp(
        { organizationId: orgB.id },
        `UPDATE spaces SET name = 'hacked' WHERE id = $1`,
        [space.id],
      );
      expect((await spaces.findById(orgA.id, space.id))!.name).toBe('Manuais');
      // Os repositórios não penduram nada da B num espaço/chave da A.
      await expect(
        keys.addVersion(orgB.id, space.id, 2, 'x', FP_NEW),
      ).rejects.toMatchObject(NOT_FOUND);
      await expect(
        grants.upsert(orgB.id, keyId, bob, 'x'),
      ).rejects.toMatchObject({
        constructor: NotFoundError,
        code: 'space-key-not-found',
      });
      await expect(
        spaceRoles.assign(orgB.id, space.id, bob, 'space_reader', null),
      ).rejects.toMatchObject(NOT_FOUND);
      await expect(
        pending.create(orgB.id, {
          id: newId(),
          spaceId: space.id,
          userId: bob,
          roleKey: 'space_reader',
          invitationId: null,
          requestedByUserId: bob,
        }),
      ).rejects.toMatchObject(NOT_FOUND);
      await expect(
        intents.record(orgB.id, newId(), [
          { spaceId: space.id, roleKey: 'space_reader' },
        ]),
      ).rejects.toMatchObject(NOT_FOUND);
      expect(await spaceRoles.activeMemberIds(orgA.id, space.id)).toEqual([
        ana,
      ]);
      const [{ n }] = (await admin.query(
        `SELECT count(*)::int AS n FROM space_key_grants`,
      )) as { n: number }[];
      expect(n).toBe(1);
    });

    // A checagem de FK ignora o RLS: só a FK composta (filho_id, organization_id) impede apontar para o pai
    // de outra organização.
    it('composite FKs: rows of B cannot point at the spaces, keys or invitations of A; same-org rows work', async () => {
      const { bob, orgA, orgB, space, keyId, inv } = await seedA();
      const dan = await makeUser('dan@x.com');
      const { space: spaceB } = await makeSpace(orgB.id, bob);
      const invB = issue(orgB.id, bob);
      await invitations.create(invB);
      const [{ id: roleId }] = (await admin.query(
        `SELECT id FROM roles WHERE key = 'space_reader' AND organization_id IS NULL`,
      )) as { id: string }[];
      const B = { organizationId: orgB.id };
      const insert = {
        key: `INSERT INTO space_keys (organization_id, space_id, version, recovery_wrapped_key, recovery_key_fingerprint) VALUES ($1, $2, 7, 'x', 'f') RETURNING id`,
        grant: `INSERT INTO space_key_grants (organization_id, space_key_id, user_id, wrapped_key) VALUES ($1, $2, $3, 'x')`,
        pending: `INSERT INTO space_pending_grants (organization_id, space_id, user_id, role_id, invitation_id) VALUES ($1, $2, $3, $4, $5)`,
        intent: `INSERT INTO invitation_space_intents (organization_id, invitation_id, space_id, role_id) VALUES ($1, $2, $3, $4)`,
        assignment: `INSERT INTO role_assignments (role_id, user_id, scope_type, organization_id, space_id) VALUES ($1, $2, 'space', $3, $4)`,
      };
      for (const [sql, params] of [
        [insert.key, [orgB.id, space.id]],
        [insert.grant, [orgB.id, keyId, dan]],
        [insert.pending, [orgB.id, space.id, dan, roleId, null]],
        [insert.pending, [orgB.id, spaceB.id, dan, roleId, inv.id]],
        [insert.intent, [orgB.id, invB.id, space.id, roleId]],
        [insert.intent, [orgB.id, inv.id, spaceB.id, roleId]],
        [insert.assignment, [roleId, dan, orgB.id, space.id]],
      ] as const) {
        await expect(asApp(B, sql, [...params])).rejects.toMatchObject({
          code: '23503',
        });
      }
      const [{ id: keyB }] = (await asApp(B, insert.key, [
        orgB.id,
        spaceB.id,
      ])) as { id: string }[];
      await asApp(B, insert.grant, [orgB.id, keyB, dan]);
      await asApp(B, insert.pending, [
        orgB.id,
        spaceB.id,
        dan,
        roleId,
        invB.id,
      ]);
      await asApp(B, insert.intent, [orgB.id, invB.id, spaceB.id, roleId]);
      await asApp(B, insert.assignment, [roleId, dan, orgB.id, spaceB.id]);
      expect(await spaceRoles.roleOf(orgB.id, spaceB.id, dan)).toBe(
        'space_reader',
      );
      // Nada da B ficou pendurado na A.
      expect(
        await asApp(
          { organizationId: orgA.id },
          `SELECT 1 FROM role_assignments WHERE user_id = $1`,
          [dan],
        ),
      ).toEqual([]);
    });

    it('revive paths require an active parent (tombstoned space or key -> NotFoundError)', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const org = await makeOrg('A', [ana], [bob]);
      const { space, keyId } = await makeSpace(org.id, ana, [
        [bob, 'space_reader'],
      ]);
      await uow.run(async () => {
        await grants.tombstoneUser(org.id, space.id, bob);
        await spaceRoles.remove(org.id, space.id, bob);
      });
      await admin.query(
        `UPDATE space_keys SET deleted_at = now() WHERE id = $1`,
        [keyId],
      );
      await expect(
        grants.upsert(org.id, keyId, bob, 'again'),
      ).rejects.toMatchObject({
        constructor: NotFoundError,
        code: 'space-key-not-found',
      });
      await expect(
        keys.setRecoveryWrap(org.id, space.id, 1, 'x', FP_NEW),
      ).rejects.toMatchObject({ code: 'space-key-not-found' });
      await admin.query(`UPDATE spaces SET deleted_at = now() WHERE id = $1`, [
        space.id,
      ]);
      await expect(
        spaceRoles.assign(org.id, space.id, bob, 'space_reader', ana),
      ).rejects.toMatchObject(NOT_FOUND);
      const rows = (await admin.query(
        `SELECT deleted_at FROM role_assignments WHERE scope_type = 'space' AND user_id = $1`,
        [bob],
      )) as { deleted_at: Date | null }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.deleted_at).not.toBeNull();
    });

    it('role_assignments: space rows pass the org policy, and self_read stays limited to the own rows', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const cid = await makeUser('cid@x.com');
      const org = await makeOrg('A', [ana], [bob]);
      const { space } = await makeSpace(org.id, ana, [[bob, 'space_reader']]);

      const inOrg = await asApp(
        { organizationId: org.id },
        `SELECT user_id FROM role_assignments WHERE scope_type = 'space' ORDER BY user_id`,
      );
      expect(inOrg).toEqual([{ user_id: ana }, { user_id: bob }]);
      // Bob só com o próprio contexto de usuário: vê as próprias linhas (org e espaço), nunca as da Ana.
      const own = await asApp(
        { userId: bob },
        `SELECT user_id, scope_type FROM role_assignments ORDER BY scope_type`,
      );
      expect(own).toEqual([
        { user_id: bob, scope_type: 'organization' },
        { user_id: bob, scope_type: 'space' },
      ]);
      expect(
        await asApp(
          { userId: cid },
          `SELECT 1 FROM role_assignments WHERE space_id = $1`,
          [space.id],
        ),
      ).toEqual([]);
      // Uma linha de espaço precisa de organization_id e space_id.
      const [{ id: roleId }] = (await admin.query(
        `SELECT id FROM roles WHERE key = 'space_reader' AND organization_id IS NULL`,
      )) as { id: string }[];
      await expect(
        admin.query(
          `INSERT INTO role_assignments (role_id, user_id, scope_type, organization_id) VALUES ($1, $2, 'space', $3)`,
          [roleId, cid, org.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      // FK para spaces.
      await expect(
        admin.query(
          `INSERT INTO role_assignments (role_id, user_id, scope_type, organization_id, space_id) VALUES ($1, $2, 'space', $3, $4)`,
          [roleId, cid, org.id, newId()],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      // Uma atribuição ativa por pessoa em cada espaço.
      await expect(
        admin.query(
          `INSERT INTO role_assignments (role_id, user_id, scope_type, organization_id, space_id) VALUES ($1, $2, 'space', $3, $4)`,
          [roleId, bob, org.id, space.id],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('the runtime role cannot DELETE from the space tables', async () => {
      const { orgA } = await seedA();
      for (const t of SPACE_TABLES) {
        await expect(
          asApp({ organizationId: orgA.id }, `DELETE FROM ${t}`),
        ).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('works the same when the tables belong to a non-superuser owner', async () => {
      const { ana, orgA, space, cid } = await seedA();
      const [{ owner }] = (await admin.query(
        `SELECT current_user AS owner`,
      )) as { owner: string }[];
      const tables = [...SPACE_TABLES, 'role_assignments', 'roles'];
      await admin.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rls_probe_owner') THEN
            CREATE ROLE rls_probe_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
          END IF;
        END $$`);
      try {
        for (const t of tables) {
          await admin.query(`ALTER TABLE "${t}" OWNER TO rls_probe_owner`);
        }
        const listed = await spaces.listForMember(orgA.id, ana, FP_OLD, {
          limit: 10,
        });
        expect(listed.items.map((i) => [i.space.id, i.pendingGrants])).toEqual([
          [space.id, 1],
        ]);
        expect(
          (await pending.findPending(orgA.id, space.id, cid))?.roleKey,
        ).toBe('space_editor');
        expect(await asApp({ userId: cid }, `SELECT 1 FROM spaces`)).toEqual(
          [],
        );
      } finally {
        for (const t of tables) {
          await admin.query(`ALTER TABLE "${t}" OWNER TO "${owner}"`);
        }
      }
    });
  });

  describe('SpaceRepository', () => {
    it('creates, finds and saves; sync_version on spaces, space_keys and space_key_grants', async () => {
      const ana = await makeUser('ana@x.com');
      const org = await makeOrg('A', [ana]);
      const { space, keyId } = await makeSpace(org.id, ana);
      const found = await spaces.findById(org.id, space.id);
      expect(found).toMatchObject({
        id: space.id,
        organizationId: org.id,
        name: 'Manuais',
        currentKeyVersion: 1,
        keyRotationRequired: false,
      });
      expect(found!.createdAt!.toISOString()).toBe(now.toISOString());
      expect(await spaces.findById(org.id, newId())).toBeNull();
      expect(await spaces.findById(org.id, 'not-a-uuid')).toBeNull();

      const syncOf = async (table: string, where: string, id: string) => {
        const [row] = (await admin.query(
          `SELECT sync_version FROM ${table} WHERE ${where} = $1`,
          [id],
        )) as { sync_version: string }[];
        return BigInt(row!.sync_version);
      };
      const s1 = await syncOf('spaces', 'id', space.id);
      const k1 = await syncOf('space_keys', 'id', keyId);
      const g1 = await syncOf('space_key_grants', 'space_key_id', keyId);
      expect(s1 > 0n && k1 > 0n && g1 > 0n).toBe(true);

      found!.rename('Manuais 2');
      found!.markRotationRequired();
      await spaces.save(found!);
      await keys.setRecoveryWrap(org.id, space.id, 1, 'rw2', FP_NEW);
      await grants.upsert(org.id, keyId, ana, 'wk2');
      expect(await syncOf('spaces', 'id', space.id)).toBeGreaterThan(s1);
      expect(await syncOf('space_keys', 'id', keyId)).toBeGreaterThan(k1);
      expect(
        await syncOf('space_key_grants', 'space_key_id', keyId),
      ).toBeGreaterThan(g1);

      const saved = await spaces.findById(org.id, space.id);
      expect(saved).toMatchObject({
        name: 'Manuais 2',
        keyRotationRequired: true,
      });
      saved!.completeRotation(2);
      await keys.addVersion(org.id, space.id, 2, 'rw-v2', FP_NEW);
      await spaces.save(saved!);
      expect(await spaces.findById(org.id, space.id)).toMatchObject({
        currentKeyVersion: 2,
        keyRotationRequired: false,
      });
      expect(
        (await keys.versions(org.id, space.id)).map((v) => [
          v.version,
          v.recoveryWrappedKey,
          v.recoveryKeyFingerprint,
        ]),
      ).toEqual([
        [1, 'rw2', FP_NEW],
        [2, 'rw-v2', FP_NEW],
      ]);
      // Uma versão ativa por número.
      await expect(
        keys.addVersion(org.id, space.id, 2, 'dup', FP_NEW),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('listForMember: only my spaces, with role and flags computed in the query, paginated', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const cid = await makeUser('cid@x.com');
      const org = await makeOrg('A', [ana], [bob, cid]);
      const { space: s1 } = await makeSpace(org.id, ana, [
        [bob, 'space_editor'],
      ]);
      const { space: s2 } = await makeSpace(org.id, bob, [], 'Vendas');
      const { space: s3 } = await makeSpace(org.id, ana, [
        [bob, 'space_reader'],
      ]);
      await spaceRoles.remove(org.id, s3.id, bob);
      await pending.create(org.id, {
        id: newId(),
        spaceId: s1.id,
        userId: cid,
        roleKey: 'space_reader',
        invitationId: null,
        requestedByUserId: ana,
      });
      const s1d = (await spaces.findById(org.id, s1.id))!;
      s1d.markRotationRequired();
      await spaces.save(s1d);

      const all = await spaces.listForMember(org.id, bob, FP_OLD, {
        limit: 10,
      });
      expect(
        all.items.map((i) => [
          i.space.id,
          i.roleKey,
          i.keyRotationRequired,
          i.recoveryRewrapRequired,
          i.pendingGrants,
        ]),
      ).toEqual([
        [s1.id, 'space_editor', true, false, 1],
        [s2.id, 'space_manager', false, false, 0],
      ]);
      expect(all.nextCursor).toBeNull();

      // O kit mudou: toda versão trancada com o antigo pede retrancar; sem kit, nunca.
      const changed = await spaces.listForMember(org.id, bob, FP_NEW, {
        limit: 10,
      });
      expect(changed.items.map((i) => i.recoveryRewrapRequired)).toEqual([
        true,
        true,
      ]);
      await keys.setRecoveryWrap(org.id, s2.id, 1, 'rw', FP_NEW);
      const partly = await spaces.listForMember(org.id, bob, FP_NEW, {
        limit: 10,
      });
      expect(partly.items.map((i) => i.recoveryRewrapRequired)).toEqual([
        true,
        false,
      ]);
      const noKit = await spaces.listForMember(org.id, bob, null, {
        limit: 10,
      });
      expect(noKit.items.map((i) => i.recoveryRewrapRequired)).toEqual([
        false,
        false,
      ]);

      const p1 = await spaces.listForMember(org.id, bob, FP_OLD, { limit: 1 });
      expect(p1.items.map((i) => i.space.id)).toEqual([s1.id]);
      const p2 = await spaces.listForMember(org.id, bob, FP_OLD, {
        limit: 1,
        cursor: p1.nextCursor!,
      });
      expect(p2.items.map((i) => i.space.id)).toEqual([s2.id]);
      expect(p2.nextCursor).toBeNull();
      expect(
        (await spaces.listForMember(org.id, cid, FP_OLD, { limit: 10 })).items,
      ).toEqual([]);
    });

    it('listAll: every space of the organization with the active member count', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const org = await makeOrg('A', [ana], [bob]);
      const { space: s1 } = await makeSpace(org.id, ana, [
        [bob, 'space_reader'],
      ]);
      const { space: s2 } = await makeSpace(org.id, bob, [], 'Vendas');
      await spaceRoles.remove(org.id, s2.id, bob);
      const page = await spaces.listAll(org.id, { limit: 10 });
      expect(page.items.map((i) => [i.space.id, i.memberCount])).toEqual([
        [s1.id, 2],
        [s2.id, 0],
      ]);
      const p1 = await spaces.listAll(org.id, { limit: 1 });
      expect(p1.nextCursor).not.toBeNull();
    });

    it('lockForUpdate requires a unit of work and serializes concurrent callers', async () => {
      const ana = await makeUser('ana@x.com');
      const org = await makeOrg('A', [ana]);
      const { space } = await makeSpace(org.id, ana);
      await expect(spaces.lockForUpdate(org.id, space.id)).rejects.toThrow(
        /unit of work/,
      );
      const hold = gate();
      const locked = gate();
      const first = uow.run(async () => {
        const s = await spaces.lockForUpdate(org.id, space.id);
        locked.release();
        s!.completeRotation(2);
        await keys.addVersion(org.id, space.id, 2, 'rw', FP_OLD);
        await spaces.save(s!);
        await hold.promise;
      });
      await locked.promise;
      let secondDone = false;
      const second = uow
        .run(() => spaces.lockForUpdate(org.id, space.id))
        .then((s) => {
          secondDone = true;
          return s;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(secondDone).toBe(false);
      hold.release();
      await first;
      // Quem esperou lê o resultado de quem segurava o lock.
      expect((await second)!.currentKeyVersion).toBe(2);
      expect(
        await uow.run(() => spaces.lockForUpdate(org.id, newId())),
      ).toBeNull();
    });
  });

  describe('SpaceRoleRepository', () => {
    it('assigns, replaces, lists members and revives a tombstone on re-entry', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const org = await makeOrg('A', [ana], [bob]);
      const { space } = await makeSpace(org.id, ana, [[bob, 'space_reader']]);
      expect(await spaceRoles.roleOf(org.id, space.id, bob)).toBe(
        'space_reader',
      );
      await spaceRoles.assign(org.id, space.id, bob, 'space_editor', ana);
      expect(await spaceRoles.roleOf(org.id, space.id, bob)).toBe(
        'space_editor',
      );
      expect(await spaceRoles.activeMemberIds(org.id, space.id)).toEqual(
        [ana, bob].sort(),
      );
      const p1 = await spaceRoles.listMembers(org.id, space.id, { limit: 1 });
      expect(p1.items.map((m) => m.userId)).toEqual([[ana, bob].sort()[0]]);
      const p2 = await spaceRoles.listMembers(org.id, space.id, {
        limit: 1,
        cursor: p1.nextCursor!,
      });
      expect(p2.items).toHaveLength(1);
      expect(p2.nextCursor).toBeNull();
      expect(p2.items[0]!.joinedAt).toBeInstanceOf(Date);

      await spaceRoles.remove(org.id, space.id, bob);
      expect(await spaceRoles.roleOf(org.id, space.id, bob)).toBeNull();
      expect(await spaceRoles.activeMemberIds(org.id, space.id)).toEqual([ana]);
      await spaceRoles.assign(org.id, space.id, bob, 'space_reader', ana);
      const rows = (await admin.query(
        `SELECT deleted_at FROM role_assignments WHERE scope_type = 'space' AND user_id = $1`,
        [bob],
      )) as { deleted_at: Date | null }[];
      expect(rows).toEqual([{ deleted_at: null }]);
    });

    it('lockSpaceManagers requires a unit of work, returns sorted ids and serializes', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const org = await makeOrg('A', [ana], [bob]);
      const { space } = await makeSpace(org.id, ana, [[bob, 'space_manager']]);
      await expect(
        spaceRoles.lockSpaceManagers(org.id, space.id),
      ).rejects.toThrow(/unit of work/);

      const hold = gate();
      const locked = gate();
      const first = uow.run(async () => {
        const ids = await spaceRoles.lockSpaceManagers(org.id, space.id);
        locked.release();
        await spaceRoles.assign(org.id, space.id, bob, 'space_reader', ana);
        await hold.promise;
        return ids;
      });
      await locked.promise;
      let secondDone = false;
      const second = uow
        .run(() => spaceRoles.lockSpaceManagers(org.id, space.id))
        .then((ids) => {
          secondDone = true;
          return ids;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(secondDone).toBe(false);
      hold.release();
      expect(await first).toEqual([ana, bob].sort());
      expect(await second).toEqual([ana]);
    });
  });

  describe('leaving the organization', () => {
    it('tombstoneUserInOrg / removeUserInOrg return the affected spaces and never touch another organization', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const orgA = await makeOrg('A', [ana], [bob]);
      const orgB = await makeOrg('B', [bob]);
      const { space: s1 } = await makeSpace(orgA.id, ana, [
        [bob, 'space_reader'],
      ]);
      const { space: s2 } = await makeSpace(orgA.id, bob, [], 'Vendas');
      await makeSpace(orgA.id, ana, [], 'Sem Bob');
      const { space: sb } = await makeSpace(orgB.id, bob, [], 'B');

      const [fromGrants, fromRoles] = await uow.run(async () => [
        await grants.tombstoneUserInOrg(orgA.id, bob),
        await spaceRoles.removeUserInOrg(orgA.id, bob),
      ]);
      expect([...fromGrants].sort()).toEqual([s1.id, s2.id].sort());
      expect([...fromRoles].sort()).toEqual([s1.id, s2.id].sort());
      expect(await grants.forUser(orgA.id, s1.id, bob)).toEqual([]);
      expect(await spaceRoles.roleOf(orgA.id, s2.id, bob)).toBeNull();
      // Nada muda na B nem para a Ana.
      expect(await grants.forUser(orgB.id, sb.id, bob)).toHaveLength(1);
      expect(await spaceRoles.roleOf(orgB.id, sb.id, bob)).toBe(
        'space_manager',
      );
      expect(await grants.forUser(orgA.id, s1.id, ana)).toHaveLength(1);
      // Segunda chamada: nada mais a mudar.
      expect(await grants.tombstoneUserInOrg(orgA.id, bob)).toEqual([]);
      expect(await spaceRoles.removeUserInOrg(orgA.id, bob)).toEqual([]);
    });
  });

  describe('SpaceGrantRepository', () => {
    it('forUser lists ascending by version; re-entry revives the tombstoned grant (no duplicate row)', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const org = await makeOrg('A', [ana], [bob]);
      const { space, keyId } = await makeSpace(org.id, ana, [
        [bob, 'space_reader'],
      ]);
      const v2 = await keys.addVersion(org.id, space.id, 2, 'rw2', FP_OLD);
      await grants.upsert(org.id, v2.id, bob, 'bob-2');
      expect(await grants.forUser(org.id, space.id, bob)).toEqual([
        { spaceKeyId: keyId, version: 1, wrappedKey: wrapped(`${bob}-1`) },
        { spaceKeyId: v2.id, version: 2, wrappedKey: 'bob-2' },
      ]);

      await grants.tombstoneUser(org.id, space.id, bob);
      expect(await grants.forUser(org.id, space.id, bob)).toEqual([]);
      expect(await grants.forUser(org.id, space.id, ana)).toHaveLength(1);

      await grants.upsert(org.id, keyId, bob, 'bob-1b');
      await grants.upsert(org.id, v2.id, bob, 'bob-2b');
      expect(
        (await grants.forUser(org.id, space.id, bob)).map((g) => g.wrappedKey),
      ).toEqual(['bob-1b', 'bob-2b']);
      const rows = (await admin.query(
        `SELECT deleted_at FROM space_key_grants WHERE user_id = $1`,
        [bob],
      )) as { deleted_at: Date | null }[];
      expect(rows).toEqual([{ deleted_at: null }, { deleted_at: null }]);
      // Upsert de cópia ativa troca o valor na mesma linha.
      await grants.upsert(org.id, keyId, bob, 'bob-1c');
      expect(
        (await admin.query(
          `SELECT count(*)::int AS n FROM space_key_grants WHERE user_id = $1`,
          [bob],
        )) as { n: number }[],
      ).toEqual([{ n: 2 }]);
    });

    it('concurrent upserts of the same grant end with one row', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const org = await makeOrg('A', [ana], [bob]);
      const { keyId } = await makeSpace(org.id, ana);
      await Promise.all([
        grants.upsert(org.id, keyId, bob, 'x1'),
        grants.upsert(org.id, keyId, bob, 'x2'),
      ]);
      expect(
        (await admin.query(
          `SELECT count(*)::int AS n FROM space_key_grants WHERE user_id = $1`,
          [bob],
        )) as { n: number }[],
      ).toEqual([{ n: 1 }]);
    });
  });

  describe('PendingGrantRepository', () => {
    it('creates, finds, lists, declines, grants and cancels', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const cid = await makeUser('cid@x.com');
      const org = await makeOrg('A', [ana], [bob, cid]);
      const { space } = await makeSpace(org.id, ana);
      const { space: other } = await makeSpace(org.id, ana, [], 'Outro');
      const inv = issue(org.id, ana);
      await invitations.create(inv);
      const id1 = newId();
      await pending.create(org.id, {
        id: id1,
        spaceId: space.id,
        userId: bob,
        roleKey: 'space_editor',
        invitationId: inv.id,
        requestedByUserId: ana,
      });
      const found = await pending.findPending(org.id, space.id, bob);
      expect(found).toMatchObject({
        id: id1,
        spaceId: space.id,
        userId: bob,
        roleKey: 'space_editor',
        invitationId: inv.id,
        requestedByUserId: ana,
        status: 'pending',
      });
      expect(found!.createdAt).toBeInstanceOf(Date);
      // Uma pendência aberta por pessoa em cada espaço.
      await expect(
        pending.create(org.id, {
          id: newId(),
          spaceId: space.id,
          userId: bob,
          roleKey: 'space_reader',
          invitationId: null,
          requestedByUserId: ana,
        }),
      ).rejects.toMatchObject({ code: '23505' });
      const id2 = newId();
      await pending.create(org.id, {
        id: id2,
        spaceId: space.id,
        userId: cid,
        roleKey: 'space_reader',
        invitationId: null,
        requestedByUserId: null,
      });
      const p1 = await pending.listPending(org.id, space.id, { limit: 1 });
      expect(p1.items.map((p) => p.id)).toEqual([id1]);
      const p2 = await pending.listPending(org.id, space.id, {
        limit: 1,
        cursor: p1.nextCursor!,
      });
      expect(p2.items.map((p) => p.id)).toEqual([id2]);
      expect(p2.nextCursor).toBeNull();

      expect(await pending.decline(org.id, space.id, cid)).toBe(true);
      expect(await pending.decline(org.id, space.id, cid)).toBe(false);
      expect(await pending.findPending(org.id, space.id, cid)).toBeNull();
      await pending.markGranted(org.id, space.id, bob);
      expect(await pending.findPending(org.id, space.id, bob)).toBeNull();
      expect(
        (await pending.listPending(org.id, space.id, { limit: 10 })).items,
      ).toEqual([]);

      // Depois de resolvida, uma nova pendência para a mesma pessoa pode existir.
      await pending.create(org.id, {
        id: newId(),
        spaceId: space.id,
        userId: bob,
        roleKey: 'space_reader',
        invitationId: null,
        requestedByUserId: ana,
      });
      await pending.create(org.id, {
        id: newId(),
        spaceId: other.id,
        userId: bob,
        roleKey: 'space_reader',
        invitationId: null,
        requestedByUserId: ana,
      });
      expect(await pending.cancelForUser(org.id, bob)).toBe(2);
      expect(await pending.cancelForUser(org.id, bob)).toBe(0);
      const statuses = (await admin.query(
        `SELECT status FROM space_pending_grants WHERE user_id = $1 ORDER BY id`,
        [bob],
      )) as { status: string }[];
      expect(statuses.map((s) => s.status)).toEqual([
        'granted',
        'cancelled',
        'cancelled',
      ]);
    });
  });

  describe('SpaceIntentRepository', () => {
    it('records and reads the intents of an invitation', async () => {
      const ana = await makeUser('ana@x.com');
      const org = await makeOrg('A', [ana]);
      const { space: s1 } = await makeSpace(org.id, ana);
      const { space: s2 } = await makeSpace(org.id, ana, [], 'Vendas');
      const inv = issue(org.id, ana);
      await invitations.create(inv);
      await intents.record(org.id, inv.id, [
        { spaceId: s1.id, roleKey: 'space_reader' },
        { spaceId: s2.id, roleKey: 'space_manager' },
      ]);
      expect(await intents.forInvitation(org.id, inv.id)).toEqual([
        { spaceId: s1.id, roleKey: 'space_reader' },
        { spaceId: s2.id, roleKey: 'space_manager' },
      ]);
      expect(await intents.forInvitation(org.id, newId())).toEqual([]);
      await intents.record(org.id, inv.id, []);
    });
  });
});
