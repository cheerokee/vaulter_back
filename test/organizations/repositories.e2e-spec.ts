import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User } from '../../src/identity/domain/user.js';
import { UserRepository } from '../../src/identity/domain/user.repository.js';
import { DEFAULT_KDF_PARAMS } from '../../src/identity/domain/kdf-params.js';
import { AuditLogRepository } from '../../src/organizations/domain/audit-log.repository.js';
import { Invitation } from '../../src/organizations/domain/invitation.js';
import { InvitationRepository } from '../../src/organizations/domain/invitation.repository.js';
import { MembershipRepository } from '../../src/organizations/domain/membership.repository.js';
import type { OrgRoleKey } from '../../src/organizations/domain/membership.js';
import { Organization } from '../../src/organizations/domain/organization.js';
import { OrganizationRepository } from '../../src/organizations/domain/organization.repository.js';
import { RoleAssignmentRepository } from '../../src/organizations/domain/role-assignment.repository.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  UnitOfWork,
  runWithContext,
} from '../../src/shared/infra/db/unit-of-work.js';
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

const now = new Date('2026-10-25T12:00:00.000Z');

describe('organizations repositories (e2e, app role)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let admin: DataSource;
  let uow: UnitOfWork;
  let users: UserRepository;
  let orgs: OrganizationRepository;
  let members: MembershipRepository;
  let roles: RoleAssignmentRepository;
  let invitations: InvitationRepository;
  let audit: AuditLogRepository;

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
        await roles.assignOrgRole(org.id, userId, role, null);
      };
      for (const u of admins) await add(u, 'org_admin');
      for (const u of plainMembers) await add(u, 'org_member');
    });
    return org;
  };

  const issue = (orgId: string, createdBy: string, issuedAt = now) =>
    Invitation.issue({
      organizationId: orgId,
      roleKey: 'org_member',
      createdBy,
      tokenHash: newId().replaceAll('-', '') + newId().replaceAll('-', ''),
      now: issuedAt,
    });

  // SQL direto pelo papel de runtime, com o contexto dado (ou nenhum).
  const asApp = (
    ctx: { organizationId?: string; userId?: string },
    sql: string,
    params: unknown[] = [],
  ): Promise<Record<string, unknown>[]> =>
    runWithContext(ds, ctx, (m) => m.query(sql, params));

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    admin = await adminDataSource();
    uow = app.get(UnitOfWork);
    users = app.get(UserRepository, { strict: false });
    orgs = app.get(OrganizationRepository, { strict: false });
    members = app.get(MembershipRepository, { strict: false });
    roles = app.get(RoleAssignmentRepository, { strict: false });
    invitations = app.get(InvitationRepository, { strict: false });
    audit = app.get(AuditLogRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  it('runs as the runtime role (not the owner)', async () => {
    const [{ u }] = (await ds.query('SELECT current_user AS u')) as {
      u: string;
    }[];
    expect(u).toBe(process.env.DB_APP_USERNAME);
  });

  describe('row-level security', () => {
    it('a non-member reads nothing of another organization, even with direct SQL', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const orgA = await makeOrg('A', [ana]);
      await makeOrg('B', [bob]);
      await invitations.create(issue(orgA.id, ana));
      await audit.append({
        organizationId: orgA.id,
        userId: ana,
        action: 'organization.created',
      });

      for (const ctx of [{}, { userId: bob }]) {
        const visible = await asApp(
          ctx,
          `SELECT id FROM organizations WHERE id = $1`,
          [orgA.id],
        );
        expect(visible).toEqual([]);
        for (const t of [
          'user_organization',
          'role_assignments',
          'organization_invitations',
          'audit_logs',
        ]) {
          expect(
            await asApp(ctx, `SELECT 1 FROM ${t} WHERE organization_id = $1`, [
              orgA.id,
            ]),
          ).toEqual([]);
        }
      }
      // Bob, no contexto dele, também não altera a organização da Ana.
      await asApp(
        { userId: bob },
        `UPDATE organizations SET name = 'hacked' WHERE id = $1`,
        [orgA.id],
      );
      const [row] = (await admin.query(
        `SELECT name FROM organizations WHERE id = $1`,
        [orgA.id],
      )) as { name: string }[];
      expect(row!.name).toBe('A');
    });

    it('a member sees the organization through the membership policy (org_member_select), and only own memberships', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const orgA = await makeOrg('A', [ana], [bob]);
      const rows = await asApp({ userId: bob }, `SELECT id FROM organizations`);
      expect(rows).toEqual([{ id: orgA.id }]);
      const links = await asApp(
        { userId: bob },
        `SELECT user_id FROM user_organization`,
      );
      expect(links).toEqual([{ user_id: bob }]);
    });

    it('a tombstoned member no longer sees the organization', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const orgA = await makeOrg('A', [ana], [bob]);
      await members.remove(orgA.id, bob);
      expect(
        await asApp({ userId: bob }, `SELECT id FROM organizations`),
      ).toEqual([]);
    });

    it('creating an organization requires its own id as context', async () => {
      const other = newId();
      await expect(
        asApp(
          { organizationId: other },
          `INSERT INTO organizations (id, name) VALUES ($1, 'x')`,
          [newId()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('roles: factory roles visible to all, custom roles only inside their organization', async () => {
      const ana = await makeUser('ana@x.com');
      const orgA = await makeOrg('A', [ana]);
      const orgB = await makeOrg('B', [ana]);
      await asApp(
        { organizationId: orgA.id },
        `INSERT INTO roles (organization_id, scope_type, name) VALUES ($1, 'space', 'Custom A')`,
        [orgA.id],
      );
      const fromB = await asApp(
        { organizationId: orgB.id },
        `SELECT name FROM roles WHERE organization_id IS NOT NULL`,
      );
      expect(fromB).toEqual([]);
      const fromA = await asApp(
        { organizationId: orgA.id },
        `SELECT name FROM roles WHERE organization_id IS NOT NULL`,
      );
      expect(fromA).toEqual([{ name: 'Custom A' }]);
      const factory = await asApp({}, `SELECT 1 FROM roles`);
      expect(factory).toHaveLength(9);
      await expect(
        asApp(
          { organizationId: orgB.id },
          `INSERT INTO roles (organization_id, scope_type, name) VALUES ($1, 'space', 'x')`,
          [orgA.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asApp(
          {},
          `INSERT INTO roles (scope_type, key, name) VALUES ('hub', 'evil', 'x')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('the runtime role reads the RBAC catalog without context', async () => {
      for (const [t, n] of [
        ['permissions', 16],
        ['permission_dependency', 2],
      ] as const) {
        expect(await asApp({}, `SELECT 1 FROM ${t}`)).toHaveLength(n);
      }
      expect(
        (await asApp({}, `SELECT 1 FROM role_permission`)).length,
      ).toBeGreaterThan(0);
    });

    it('the runtime role cannot write the RBAC catalog', async () => {
      const [{ role_id, permission_id }] = (await admin.query(
        `SELECT r.id AS role_id, p.id AS permission_id FROM roles r, permissions p
          WHERE r.key = 'org_member' AND p.key = 'org.billing'`,
      )) as { role_id: string; permission_id: string }[];
      for (const sql of [
        `INSERT INTO role_permission (role_id, permission_id) VALUES ('${role_id}', '${permission_id}')`,
        `UPDATE permissions SET name = 'x'`,
        `INSERT INTO permissions (key, scope_type, name) VALUES ('evil', 'hub', 'x')`,
        `UPDATE permission_dependency SET deleted_at = now()`,
        `UPDATE role_permission SET deleted_at = now()`,
      ]) {
        await expect(asApp({}, sql)).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('a member cannot update the organization with only the user context', async () => {
      const ana = await makeUser('ana@x.com');
      const org = await makeOrg('A', [ana]);
      await asApp(
        { userId: ana },
        `UPDATE organizations SET name = 'via user' WHERE id = $1`,
        [org.id],
      );
      expect((await orgs.findById(org.id))!.name).toBe('A');
    });

    it('the schema has no SECURITY DEFINER functions of ours', async () => {
      const rows = await admin.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prosecdef`,
      );
      expect(rows).toEqual([]);
    });

    // As policies são avaliadas com o papel de quem consulta (app_runtime), nunca com o do dono: com as
    // tabelas de um dono sem superusuário (como num Postgres gerenciado), tudo continua igual.
    it('works the same when the tables belong to a non-superuser owner', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const org = await makeOrg('A', [ana], [bob]);
      const inv = issue(org.id, ana);
      await invitations.create(inv);
      const [{ owner }] = (await admin.query(
        `SELECT current_user AS owner`,
      )) as { owner: string }[];
      const tables = [
        'organizations',
        'user_organization',
        'role_assignments',
        'organization_invitations',
        'roles',
      ];
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
        const found = await invitations.findByTokenHash(inv.tokenHash);
        expect(found?.id).toBe(inv.id);
        const listed = await orgs.listForUser(bob, { limit: 10 });
        expect(listed.items.map((i) => [i.organization.id, i.roleKey])).toEqual(
          [[org.id, 'org_member']],
        );
        const other = await makeUser('cid@x.com');
        expect(
          await asApp({ userId: other }, `SELECT id FROM organizations`),
        ).toEqual([]);
      } finally {
        for (const t of tables) {
          await admin.query(`ALTER TABLE "${t}" OWNER TO "${owner}"`);
        }
      }
    });
  });

  describe('OrganizationRepository', () => {
    it('creates, finds and saves', async () => {
      const org = Organization.create({ name: 'Acme', now });
      await orgs.create(org);
      org.rename('Acme 2');
      org.setHubLinkPolicy('admin_approved');
      org.setRecoveryKey(b64(32));
      await orgs.save(org);
      const found = await orgs.findById(org.id);
      expect(found).toMatchObject({
        id: org.id,
        name: 'Acme 2',
        hubLinkPolicy: 'admin_approved',
        plan: 'free',
        isPersonal: false,
        personalOwnerUserId: null,
        recoveryPublicKey: b64(32),
      });
      expect(found!.createdAt!.toISOString()).toBe(now.toISOString());
      const [{ sync_version }] = (await admin.query(
        `SELECT sync_version FROM organizations WHERE id = $1`,
        [org.id],
      )) as { sync_version: string }[];
      expect(BigInt(sync_version) > 0n).toBe(true);
      expect(await orgs.findById(newId())).toBeNull();
    });

    it('the unique index prevents two personal organizations for the same owner', async () => {
      const ana = await makeUser('ana@x.com');
      await orgs.create(
        Organization.createPersonal({ name: 'Ana', ownerId: ana, now }),
      );
      await expect(
        orgs.create(
          Organization.createPersonal({ name: 'Ana 2', ownerId: ana, now }),
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('listForUser brings only my organizations, with my role, paginated', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const a = await makeOrg('A', [ana]);
      const b = await makeOrg('B', [bob], [ana]);
      await makeOrg('C', [bob]);
      const left = await makeOrg('D', [bob], [ana]);
      await members.remove(left.id, ana);

      const all = await orgs.listForUser(ana, { limit: 10 });
      expect(all.items.map((i) => [i.organization.name, i.roleKey])).toEqual([
        ['A', 'org_admin'],
        ['B', 'org_member'],
      ]);
      expect(all.nextCursor).toBeNull();

      const p1 = await orgs.listForUser(ana, { limit: 1 });
      expect(p1.items.map((i) => i.organization.id)).toEqual([a.id]);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = await orgs.listForUser(ana, {
        limit: 1,
        cursor: p1.nextCursor!,
      });
      expect(p2.items.map((i) => i.organization.id)).toEqual([b.id]);
      expect(p2.nextCursor).toBeNull();
    });
  });

  describe('MembershipRepository', () => {
    it('tombstone and re-entry reuse the same row', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const org = await makeOrg('A', [ana], [bob]);
      expect(await members.find(org.id, bob)).toMatchObject({
        organizationId: org.id,
        userId: bob,
        roleKey: 'org_member',
      });
      expect(await members.countActive(org.id)).toBe(2);

      await members.remove(org.id, bob);
      expect(await members.find(org.id, bob)).toBeNull();
      expect(await members.countActive(org.id)).toBe(1);
      // A atribuição de papel da organização vai junto para a lápide.
      expect(await roles.orgRoleOf(org.id, bob)).toBeNull();

      await uow.run(async () => {
        await members.add(org.id, bob, now);
        await roles.assignOrgRole(org.id, bob, 'org_member', ana);
      });
      const rows = (await admin.query(
        `SELECT deleted_at FROM user_organization WHERE organization_id = $1 AND user_id = $2`,
        [org.id, bob],
      )) as { deleted_at: Date | null }[];
      expect(rows).toEqual([{ deleted_at: null }]);
      expect(await members.find(org.id, bob)).not.toBeNull();
      // add num membro ativo é idempotente.
      await members.add(org.id, bob, now);
      expect(await members.countActive(org.id)).toBe(2);
    });

    it('lists members with cursor and counts admins', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const cid = await makeUser('cid@x.com');
      const org = await makeOrg('A', [ana, bob], [cid]);
      expect(await members.countAdmins(org.id)).toBe(2);
      const p1 = await members.list(org.id, { limit: 2 });
      expect(p1.items.map((m) => m.userId)).toEqual([ana, bob]);
      const p2 = await members.list(org.id, {
        limit: 2,
        cursor: p1.nextCursor!,
      });
      expect(p2.items.map((m) => [m.userId, m.roleKey])).toEqual([
        [cid, 'org_member'],
      ]);
      expect(p2.nextCursor).toBeNull();
    });
  });

  describe('RoleAssignmentRepository', () => {
    it('assignOrgRole replaces the role, keeping one active assignment', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const org = await makeOrg('A', [ana], [bob]);
      expect(await roles.orgRoleOf(org.id, bob)).toBe('org_member');
      expect(await roles.permissionsOf(org.id, bob)).toEqual([]);
      await roles.assignOrgRole(org.id, bob, 'org_admin', ana);
      expect(await roles.orgRoleOf(org.id, bob)).toBe('org_admin');
      expect(await roles.permissionsOf(org.id, bob)).toEqual([
        'org.billing',
        'org.hubs.approve',
        'org.members.manage',
        'org.spaces.create',
      ]);
      const rows = (await admin.query(
        `SELECT granted_by_user_id FROM role_assignments WHERE user_id = $1 AND deleted_at IS NULL`,
        [bob],
      )) as { granted_by_user_id: string }[];
      expect(rows).toEqual([{ granted_by_user_id: ana }]);
      expect(await roles.orgRoleOf(org.id, newId())).toBeNull();
    });

    it('lockOrgAdmins requires a unit of work and serializes concurrent callers', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const org = await makeOrg('A', [ana, bob]);
      await expect(roles.lockOrgAdmins(org.id)).rejects.toThrow(/unit of work/);

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let firstLocked!: () => void;
      const locked = new Promise<void>((r) => (firstLocked = r));
      const first = uow.run(async () => {
        const ids = await roles.lockOrgAdmins(org.id);
        firstLocked();
        await gate;
        return ids;
      });
      await locked;
      let secondDone = false;
      const second = uow
        .run(() => roles.lockOrgAdmins(org.id))
        .then((ids) => {
          secondDone = true;
          return ids;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(secondDone).toBe(false);
      release();
      expect((await first).sort()).toEqual([ana, bob].sort());
      expect((await second).sort()).toEqual([ana, bob].sort());
    });

    it('lockOrgAdmins: the waiting caller sees the result of the one holding the lock', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const org = await makeOrg('A', [ana, bob]);

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let firstLocked!: () => void;
      const locked = new Promise<void>((r) => (firstLocked = r));
      const first = uow.run(async () => {
        const ids = await roles.lockOrgAdmins(org.id);
        firstLocked();
        await roles.assignOrgRole(org.id, bob, 'org_member', ana);
        await gate;
        return ids;
      });
      await locked;
      const second = uow.run(() => roles.lockOrgAdmins(org.id));
      await new Promise((r) => setTimeout(r, 200));
      release();
      expect((await first).sort()).toEqual([ana, bob].sort());
      expect(await second).toEqual([ana]);
    });
  });

  describe('InvitationRepository', () => {
    it('finds by token hash without context, lists pending and revokes', async () => {
      const ana = await makeUser('ana@x.com');
      const org = await makeOrg('A', [ana]);
      const inv = issue(org.id, ana);
      await invitations.create(inv);
      const found = await invitations.findByTokenHash(inv.tokenHash);
      expect(found).toMatchObject({
        id: inv.id,
        organizationId: org.id,
        roleKey: 'org_member',
        status: 'pending',
        email: null,
        createdBy: ana,
      });
      expect(found!.expiresAt.toISOString()).toBe(inv.expiresAt.toISOString());
      expect(await invitations.findByTokenHash('nope')).toBeNull();
      // Hash vazio não pula o filtro, nem dentro do contexto da organização do convite.
      expect(
        await uow.withContext({ organizationId: org.id }, () =>
          invitations.findByTokenHash(''),
        ),
      ).toBeNull();
      // O hash no contexto abre só aquele convite, e não fica no unit of work depois da busca.
      const other0 = issue(org.id, ana);
      await invitations.create(other0);
      expect(
        await asApp(
          { invitationTokenHash: inv.tokenHash },
          `SELECT id FROM organization_invitations`,
        ),
      ).toEqual([{ id: inv.id }]);
      const leftover = await uow.run(async () => {
        await invitations.findByTokenHash(inv.tokenHash);
        // Mesma transação do unit of work (asApp entra nela num savepoint).
        const [row] = (await asApp(
          {},
          `SELECT COALESCE(current_setting('app.invitation_token_hash', true), '') AS v`,
        )) as { v: string }[];
        return row!.v;
      });
      expect(leftover).toBe('');
      await invitations.revoke(org.id, other0.id);

      const other = issue(org.id, ana);
      await invitations.create(other);
      const page = await invitations.listPending(org.id, { limit: 1 }, now);
      expect(page.items.map((i) => i.id)).toEqual([other.id]);
      expect(page.nextCursor).not.toBeNull();

      expect(await invitations.revoke(org.id, other.id)).toBe(true);
      expect(await invitations.revoke(org.id, other.id)).toBe(false);
      const after = await invitations.listPending(org.id, { limit: 10 }, now);
      expect(after.items.map((i) => i.id)).toEqual([inv.id]);
      expect((await invitations.findByTokenHash(other.tokenHash))!.status).toBe(
        'revoked',
      );
    });

    it('concurrent markAccepted: only one wins', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const cid = await makeUser('cid@x.com');
      const org = await makeOrg('A', [ana]);
      const inv = issue(org.id, ana);
      await invitations.create(inv);
      const results = await Promise.all([
        invitations.markAccepted(org.id, inv.id, bob, now),
        invitations.markAccepted(org.id, inv.id, cid, now),
      ]);
      expect([...results].sort((a, b) => Number(a) - Number(b))).toEqual([
        false,
        true,
      ]);
      const found = await invitations.findByTokenHash(inv.tokenHash);
      expect(found!.status).toBe('accepted');
      expect([bob, cid]).toContain(found!.acceptedBy);
      expect(found!.acceptedAt!.toISOString()).toBe(now.toISOString());
    });

    it('an expired or revoked invitation is not accepted', async () => {
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const org = await makeOrg('A', [ana]);
      const expired = issue(org.id, ana, new Date('2026-10-01T00:00:00Z'));
      await invitations.create(expired);
      expect(await invitations.markAccepted(org.id, expired.id, bob, now)).toBe(
        false,
      );
      const revoked = issue(org.id, ana);
      await invitations.create(revoked);
      await invitations.revoke(org.id, revoked.id);
      expect(await invitations.markAccepted(org.id, revoked.id, bob, now)).toBe(
        false,
      );
      // Outra organização no contexto não aceita o convite (RLS).
      const ok = issue(org.id, ana);
      await invitations.create(ok);
      expect(await invitations.markAccepted(newId(), ok.id, bob, now)).toBe(
        false,
      );
      expect(await invitations.markAccepted(org.id, ok.id, bob, now)).toBe(
        true,
      );
    });
  });

  describe('AuditLogRepository', () => {
    it('audit_logs only accepts appends', async () => {
      const ana = await makeUser('ana@x.com');
      const org = await makeOrg('A', [ana]);
      await audit.append({
        organizationId: org.id,
        userId: ana,
        action: 'member.joined',
        metadata: { roleKey: 'org_admin' },
      });
      const rows = (await admin.query(
        `SELECT action, result, metadata, user_id FROM audit_logs WHERE organization_id = $1`,
        [org.id],
      )) as Record<string, unknown>[];
      expect(rows).toEqual([
        {
          action: 'member.joined',
          result: 'success',
          metadata: { roleKey: 'org_admin' },
          user_id: ana,
        },
      ]);
      await expect(
        asApp({ organizationId: org.id }, `UPDATE audit_logs SET action = 'x'`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asApp({ organizationId: org.id }, `DELETE FROM audit_logs`),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});
