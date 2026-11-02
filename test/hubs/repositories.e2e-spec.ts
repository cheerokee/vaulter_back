import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User } from '../../src/identity/domain/user.js';
import { UserRepository } from '../../src/identity/domain/user.repository.js';
import { DEFAULT_KDF_PARAMS } from '../../src/identity/domain/kdf-params.js';
import { AuthChallengeRepository } from '../../src/hubs/domain/auth-challenge.repository.js';
import { Enrollment } from '../../src/hubs/domain/enrollment.js';
import { EnrollmentRepository } from '../../src/hubs/domain/enrollment.repository.js';
import { HubOrganizationLink } from '../../src/hubs/domain/hub-organization-link.js';
import { HubOrganizationRepository } from '../../src/hubs/domain/hub-organization.repository.js';
import { HubRoleRepository } from '../../src/hubs/domain/hub-role.repository.js';
import { HubSpaceRepository } from '../../src/hubs/domain/hub-space.repository.js';
import { Hub } from '../../src/hubs/domain/hub.js';
import { HubRepository } from '../../src/hubs/domain/hub.repository.js';
import { LinkCode } from '../../src/hubs/domain/link-code.js';
import { LinkCodeRepository } from '../../src/hubs/domain/link-code.repository.js';
import { MembershipRepository } from '../../src/organizations/domain/membership.repository.js';
import type { OrgRoleKey } from '../../src/organizations/domain/membership.js';
import { Organization } from '../../src/organizations/domain/organization.js';
import { OrganizationRepository } from '../../src/organizations/domain/organization.repository.js';
import { RoleAssignmentRepository } from '../../src/organizations/domain/role-assignment.repository.js';
import {
  ConflictError,
  NotFoundError,
} from '../../src/shared/domain/errors.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  UnitOfWork,
  runWithContext,
  type UnitOfWorkContext,
} from '../../src/shared/infra/db/unit-of-work.js';
import { Space } from '../../src/spaces/domain/space.js';
import { SpaceRepository } from '../../src/spaces/domain/space.repository.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { createHubIdentity } from '../support/hub-crypto.js';

const b64 = (n: number, first?: number) => {
  const b = Buffer.alloc(n, 0xab);
  if (first !== undefined) b[0] = first;
  return b.toString('base64url');
};
const hex = (tag: string) => tag.padEnd(64, '0');

const now = new Date('2026-11-01T12:00:00.000Z');
const later = (ms: number) => new Date(now.getTime() + ms);

const HUB_TABLES = [
  'hubs',
  'hub_enrollments',
  'hub_link_codes',
  'hub_auth_challenges',
  'hub_organization',
  'hub_space',
] as const;

// Sempre pelo papel de runtime (o DataSource da aplicação): o dono das tabelas é superusuário e ignora o RLS.
describe('hubs repositories (e2e, app role)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let admin: DataSource;
  let uow: UnitOfWork;
  let users: UserRepository;
  let orgs: OrganizationRepository;
  let members: MembershipRepository;
  let orgRoles: RoleAssignmentRepository;
  let spaces: SpaceRepository;
  let hubs: HubRepository;
  let enrollments: EnrollmentRepository;
  let linkCodes: LinkCodeRepository;
  let challenges: AuthChallengeRepository;
  let links: HubOrganizationRepository;
  let hubSpaces: HubSpaceRepository;
  let hubRoles: HubRoleRepository;

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

  const makeSpace = async (orgId: string, name = 'Manuais'): Promise<Space> => {
    const space = Space.create({ organizationId: orgId, name, now });
    await spaces.create(space);
    return space;
  };

  // Roda `work` numa unidade de trabalho com o contexto do RLS dado.
  const as = <T>(ctx: UnitOfWorkContext, work: () => Promise<T>): Promise<T> =>
    uow.run(() => uow.withContext(ctx, work));

  const makeHub = async (
    ownerUserId: string,
    name = 'Recepção',
    signingPublicKey?: string,
  ): Promise<Hub> => {
    const identity = await createHubIdentity();
    const hub = Hub.restore(
      {
        ownerUserId,
        name,
        signingPublicKey: signingPublicKey ?? identity.signingPublicKey,
        encryptionPublicKey: identity.encryptionPublicKey,
        lastSeenAt: null,
        deletedAt: null,
        createdAt: now,
      },
      newId(),
    );
    await as({ userId: ownerUserId }, () => hubs.create(hub));
    return hub;
  };

  // Vínculo aprovado (o dono vincula com any_member_hub): gravado pelo dono, como na reivindicação.
  const link = async (
    hub: Hub,
    orgId: string,
    status: 'approved' | 'pending' = 'approved',
  ): Promise<void> => {
    const l = HubOrganizationLink.ownerLinks({
      hubId: hub.id,
      organizationId: orgId,
      userId: hub.ownerUserId,
      policy: status === 'approved' ? 'any_member_hub' : 'admin_approved',
      now,
    });
    await as({ userId: hub.ownerUserId }, () => links.upsert(l));
  };

  // SQL direto pelo papel de runtime, com o contexto dado (ou nenhum). UPDATE devolve [linhas, contagem].
  const asApp = (
    ctx: UnitOfWorkContext,
    sql: string,
    params: unknown[] = [],
  ): Promise<Record<string, unknown>[]> =>
    runWithContext(ds, ctx, (m) => m.query(sql, params));

  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    return { promise, release };
  };

  const ids = (rows: Record<string, unknown>[], col = 'id') =>
    rows.map((r) => r[col] as string).sort();

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    admin = await adminDataSource();
    uow = app.get(UnitOfWork);
    users = app.get(UserRepository, { strict: false });
    orgs = app.get(OrganizationRepository, { strict: false });
    members = app.get(MembershipRepository, { strict: false });
    orgRoles = app.get(RoleAssignmentRepository, { strict: false });
    spaces = app.get(SpaceRepository, { strict: false });
    hubs = app.get(HubRepository, { strict: false });
    enrollments = app.get(EnrollmentRepository, { strict: false });
    linkCodes = app.get(LinkCodeRepository, { strict: false });
    challenges = app.get(AuthChallengeRepository, { strict: false });
    links = app.get(HubOrganizationRepository, { strict: false });
    hubSpaces = app.get(HubSpaceRepository, { strict: false });
    hubRoles = app.get(HubRoleRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  describe('hubs: row-level security', () => {
    // Olivia é dona do Hub; Ana é da organização A (vinculada); Bob é só da B (sem vínculo).
    const seed = async () => {
      const olivia = await makeUser('olivia@x.com');
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const orgA = await makeOrg('A', [olivia], [ana]);
      const orgB = await makeOrg('B', [bob]);
      const hub = await makeHub(olivia);
      return { olivia, ana, bob, orgA, orgB, hub };
    };

    it('the owner, a member of an approved linked organization and the hub itself see it; others do not', async () => {
      const { olivia, ana, bob, orgA, orgB, hub } = await seed();

      // Sem vínculo: só a dona e o próprio Hub.
      expect(
        (await as({ userId: olivia }, () => hubs.findById(hub.id)))?.id,
      ).toBe(hub.id);
      expect(await as({ userId: ana }, () => hubs.findById(hub.id))).toBeNull();
      expect(
        (await as({ hubId: hub.id }, () => hubs.findById(hub.id)))?.name,
      ).toBe('Recepção');
      expect(await asApp({}, `SELECT id FROM hubs`)).toEqual([]);

      // Vínculo pendente ainda não abre para os membros.
      await link(hub, orgA.id, 'pending');
      expect(await as({ userId: ana }, () => hubs.findById(hub.id))).toBeNull();

      // Aprovado: Ana (membro ativo da A) vê; Bob (só da B) não, nem com o contexto da B.
      await link(hub, orgA.id, 'approved');
      await admin.query(
        `UPDATE hub_organization SET status = 'approved' WHERE hub_id = $1`,
        [hub.id],
      );
      expect((await as({ userId: ana }, () => hubs.findById(hub.id)))?.id).toBe(
        hub.id,
      );
      expect(await as({ userId: bob }, () => hubs.findById(hub.id))).toBeNull();
      expect(
        await asApp(
          { userId: bob, organizationId: orgB.id },
          `SELECT id FROM hubs`,
        ),
      ).toEqual([]);
      // O contexto de organização sozinho não abre o Hub (o vínculo é por pessoa).
      expect(
        await asApp({ organizationId: orgA.id }, `SELECT id FROM hubs`),
      ).toEqual([]);
      // Outro Hub não vê este.
      expect(await asApp({ hubId: newId() }, `SELECT id FROM hubs`)).toEqual(
        [],
      );

      // Ana sai da A: deixa de ver.
      await admin.query(
        `UPDATE user_organization SET deleted_at = now() WHERE user_id = $1`,
        [ana],
      );
      expect(await as({ userId: ana }, () => hubs.findById(hub.id))).toBeNull();
    });

    it('only the owner (or the hub itself) writes; INSERT requires app.user_id = owner', async () => {
      const { olivia, ana, hub } = await seed();
      const identity = await createHubIdentity();
      // Ana não cria um Hub em nome da Olivia.
      await expect(
        asApp(
          { userId: ana },
          `INSERT INTO hubs (owner_user_id, name, encryption_public_key, signing_public_key)
           VALUES ($1, 'x', $2, $3)`,
          [olivia, identity.encryptionPublicKey, identity.signingPublicKey],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      // Ana não renomeia (a linha nem é visível para o UPDATE).
      expect(
        await asApp(
          { userId: ana },
          `UPDATE hubs SET name = 'x' WHERE id = $1 RETURNING id`,
          [hub.id],
        ),
      ).toEqual([[], 0]);
      // A dona renomeia; o Hub atualiza o próprio last_seen_at.
      hub.rename('Sala de reunião');
      await as({ userId: olivia }, () => hubs.save(hub));
      hub.touch(later(1000));
      await as({ hubId: hub.id }, () => hubs.save(hub));
      const saved = await as({ userId: olivia }, () => hubs.findById(hub.id));
      expect(saved?.name).toBe('Sala de reunião');
      expect(saved?.lastSeenAt?.toISOString()).toBe(later(1000).toISOString());
      // Dono e chaves são imutáveis para o runtime (GRANT UPDATE só em name, last_seen_at, deleted_at, updated_at).
      for (const set of [
        `owner_user_id = '${ana}'`,
        `signing_public_key = 'x'`,
        `encryption_public_key = 'x'`,
      ]) {
        await expect(
          asApp({ userId: olivia }, `UPDATE hubs SET ${set} WHERE id = $1`, [
            hub.id,
          ]),
        ).rejects.toMatchObject({ code: '42501' });
      }
      // Sem contexto, save falha alto em vez de não gravar em silêncio.
      await expect(hubs.save(hub)).rejects.toMatchObject({
        constructor: NotFoundError,
        code: 'hub-not-found',
      });
    });

    it('listForUser: owned and approved-linked hubs, active ones only, paginated by id', async () => {
      const { olivia, ana, orgA, hub } = await seed();
      const second = await makeHub(olivia, 'Cozinha');
      const anasOwn = await makeHub(ana, 'Ana');
      await link(hub, orgA.id);
      const page1 = await as({ userId: ana }, () =>
        hubs.listForUser(ana, { limit: 1 }),
      );
      expect(page1.items.map((h) => h.id)).toEqual([hub.id]);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await as({ userId: ana }, () =>
        hubs.listForUser(ana, { limit: 1, cursor: page1.nextCursor! }),
      );
      expect(page2.items.map((h) => h.id)).toEqual([anasOwn.id]);
      expect(page2.nextCursor).toBeNull();

      second.deregister(later(1));
      await as({ userId: olivia }, () => hubs.save(second));
      const mine = await as({ userId: olivia }, () =>
        hubs.listForUser(olivia, { limit: 10 }),
      );
      expect(mine.items.map((h) => h.id)).toEqual([hub.id]);
      // findById ainda devolve o desregistrado.
      expect(
        (await as({ userId: olivia }, () => hubs.findById(second.id)))
          ?.isDeregistered,
      ).toBe(true);
    });

    it('lockForUpdate requires a unit of work and returns the hub to the owner', async () => {
      const { olivia, hub } = await seed();
      await expect(hubs.lockForUpdate(hub.id)).rejects.toThrow(/unit of work/);
      expect(
        (await as({ userId: olivia }, () => hubs.lockForUpdate(hub.id)))?.id,
      ).toBe(hub.id);
      expect(
        await as({ userId: olivia }, () => hubs.lockForUpdate(newId())),
      ).toBeNull();
    });

    it('the signing key stays unique after deregistering, and findBySigningKey finds it without any context', async () => {
      const { olivia, hub } = await seed();
      hub.deregister(later(1));
      await as({ userId: olivia }, () => hubs.save(hub));
      const found = await hubs.findBySigningKey(hub.signingPublicKey);
      expect(found?.id).toBe(hub.id);
      expect(found?.isDeregistered).toBe(true);
      expect(await hubs.findBySigningKey(b64(32))).toBeNull();
      await expect(
        makeHub(olivia, 'Outro', hub.signingPublicKey),
      ).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'signing-key-in-use',
      });
      // O contexto da busca por chave não vaza para fora dela.
      expect(await asApp({}, `SELECT id FROM hubs`)).toEqual([]);
    });
  });

  describe('hub_organization', () => {
    it('isolates organizations; the owner and the hub see every link; tombstones are revived on upsert', async () => {
      const olivia = await makeUser('olivia@x.com');
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const orgA = await makeOrg('A', [ana]);
      const orgB = await makeOrg('B', [bob]);
      const hub = await makeHub(olivia);
      await link(hub, orgA.id);
      await link(hub, orgB.id, 'pending');

      const orgIdsSeenBy = async (ctx: UnitOfWorkContext) =>
        (await as(ctx, () => links.list(hub.id)))
          .map((l) => l.organizationId)
          .sort();

      expect(await orgIdsSeenBy({ userId: olivia })).toEqual(
        [orgA.id, orgB.id].sort(),
      );
      // O Hub só vê vínculos aprovados (e revogados, que a sincronização manda como lápide); pendente não.
      expect(await orgIdsSeenBy({ hubId: hub.id })).toEqual([orgA.id]);
      expect(await orgIdsSeenBy({ userId: ana })).toEqual([orgA.id]);
      // Membro só lê vínculo aprovado da própria organização: Bob (admin da B, pedido pendente) não vê o da B.
      expect(await orgIdsSeenBy({ userId: bob })).toEqual([]);
      expect(await orgIdsSeenBy({ organizationId: orgB.id })).toEqual([
        orgB.id,
      ]);
      expect(await orgIdsSeenBy({})).toEqual([]);
      expect(
        await as({ userId: olivia }, () => links.listActiveOrgIds(hub.id)),
      ).toEqual([orgA.id]);
      expect(
        await as({ userId: bob }, () => links.find(hub.id, orgA.id)),
      ).toBeNull();

      // B não altera o vínculo da A, nem com SQL direto.
      expect(
        await asApp(
          { organizationId: orgB.id, userId: bob },
          `UPDATE hub_organization SET status = 'revoked' WHERE organization_id = $1 RETURNING hub_id`,
          [orgA.id],
        ),
      ).toEqual([[], 0]);
      // Nem a dona escreve fora do escopo da organização (só leitura).
      expect(
        await asApp(
          { userId: olivia },
          `UPDATE hub_organization SET status = 'revoked' WHERE hub_id = $1 RETURNING hub_id`,
          [hub.id],
        ),
      ).toEqual([[], 0]);

      // Admin da A aprova/revoga no escopo da A (upsert põe o escopo); a lápide é revivida na mesma linha.
      const current = (await as({ userId: ana }, () =>
        links.find(hub.id, orgA.id),
      ))!;
      current.revoke();
      await as({ userId: ana }, () => links.upsert(current));
      expect(
        (await as({ hubId: hub.id }, () => links.list(hub.id))).map((l) => [
          l.organizationId,
          l.status,
        ]),
      ).toEqual([[orgA.id, 'revoked']]);
      expect(await orgIdsSeenBy({ userId: ana })).toEqual([]);
      await admin.query(
        `UPDATE hub_organization SET deleted_at = now() WHERE hub_id = $1 AND organization_id = $2`,
        [hub.id, orgA.id],
      );
      expect(
        await as({ userId: olivia }, () => links.find(hub.id, orgA.id)),
      ).toBeNull();
      const again = HubOrganizationLink.ownerLinks({
        hubId: hub.id,
        organizationId: orgA.id,
        userId: olivia,
        policy: 'any_member_hub',
        now,
      });
      await as({ userId: olivia }, () => links.upsert(again));
      const rows: {
        status: string;
        deleted_at: Date | null;
        hub_owner_user_id: string;
      }[] = await admin.query(
        `SELECT status, deleted_at, hub_owner_user_id FROM hub_organization WHERE hub_id = $1 AND organization_id = $2`,
        [hub.id, orgA.id],
      );
      expect(rows).toEqual([
        { status: 'approved', deleted_at: null, hub_owner_user_id: olivia },
      ]);
    });

    it('lockForUpdate requires a unit of work; upsert of a hub the caller cannot see is refused', async () => {
      const olivia = await makeUser('olivia@x.com');
      const ana = await makeUser('ana@x.com');
      const orgA = await makeOrg('A', [ana]);
      const hub = await makeHub(olivia);
      await link(hub, orgA.id);
      await expect(links.lockForUpdate(hub.id, orgA.id)).rejects.toThrow(
        /unit of work/,
      );
      expect(
        (await as({ userId: ana }, () => links.lockForUpdate(hub.id, orgA.id)))
          ?.status,
      ).toBe('approved');
      const stranger = HubOrganizationLink.requestByOther({
        hubId: newId(),
        organizationId: orgA.id,
        userId: ana,
        policy: 'any_member_hub',
        now,
      });
      await expect(
        as({ userId: ana }, () => links.upsert(stranger)),
      ).rejects.toMatchObject({
        constructor: NotFoundError,
        code: 'hub-not-found',
      });
    });

    it('upsert waits for a concurrent deregistration (hub FOR SHARE) and is refused after it commits, on both paths', async () => {
      const olivia = await makeUser('olivia@x.com');
      const ana = await makeUser('ana@x.com');
      const orgA = await makeOrg('A', [ana]);
      const orgB = await makeOrg('B', [ana]);
      const hub = await makeHub(olivia);
      await link(hub, orgA.id);
      const revoked = (await as({ userId: olivia }, () =>
        links.find(hub.id, orgA.id),
      ))!;
      revoked.revoke();
      await as({ userId: olivia }, () => links.upsert(revoked));

      const locked = gate();
      const hold = gate();
      // Desregistro: trava o Hub FOR UPDATE, grava a lápide e segura a transação.
      const deregistering = as({ userId: olivia }, async () => {
        const h = (await hubs.lockForUpdate(hub.id))!;
        h.deregister(later(1));
        await hubs.save(h);
        locked.release();
        await hold.promise;
      });
      await locked.promise;
      const attempt = (orgId: string) => {
        const l = HubOrganizationLink.ownerLinks({
          hubId: hub.id,
          organizationId: orgId,
          userId: olivia,
          policy: 'any_member_hub',
          now,
        });
        let settled = false;
        const p = as({ userId: olivia }, () => links.upsert(l)).finally(() => {
          settled = true;
        });
        return { p, settled: () => settled };
      };
      const revive = attempt(orgA.id); // caminho do UPDATE (reviver o revogado)
      const insert = attempt(orgB.id); // caminho do INSERT (organização nova)
      // Prende as rejeições já (o expect abaixo as confere): sem isso, rejeição não tratada.
      void revive.p.catch(() => undefined);
      void insert.p.catch(() => undefined);
      // Solta o desregistro mesmo se a checagem falhar (senão o teste fica preso no lock).
      let blocked: boolean[];
      try {
        await new Promise((r) => setTimeout(r, 300));
        blocked = [!revive.settled(), !insert.settled()];
      } finally {
        hold.release();
        await deregistering;
      }
      expect(blocked).toEqual([true, true]);
      for (const a of [revive, insert]) {
        await expect(a.p).rejects.toMatchObject({
          constructor: NotFoundError,
          code: 'hub-not-found',
        });
      }
      const rows: { organization_id: string; status: string }[] =
        await admin.query(
          `SELECT organization_id, status FROM hub_organization WHERE hub_id = $1`,
          [hub.id],
        );
      expect(rows).toEqual([{ organization_id: orgA.id, status: 'revoked' }]);
    });

    it('upsert refuses a deregistered hub on both paths (update and insert)', async () => {
      const olivia = await makeUser('olivia@x.com');
      const ana = await makeUser('ana@x.com');
      const orgA = await makeOrg('A', [ana]);
      const orgB = await makeOrg('B', [ana]);
      const hub = await makeHub(olivia);
      await link(hub, orgA.id);
      hub.deregister(later(1));
      await as({ userId: olivia }, () => hubs.save(hub));
      for (const orgId of [orgA.id, orgB.id]) {
        const l = HubOrganizationLink.ownerLinks({
          hubId: hub.id,
          organizationId: orgId,
          userId: olivia,
          policy: 'any_member_hub',
          now,
        });
        await expect(
          as({ userId: olivia }, () => links.upsert(l)),
        ).rejects.toMatchObject({
          constructor: NotFoundError,
          code: 'hub-not-found',
        });
      }
    });

    it('only the hub owner can be recorded as the owner consent (CHECK)', async () => {
      const olivia = await makeUser('olivia@x.com');
      const ana = await makeUser('ana@x.com');
      const orgA = await makeOrg('A', [ana]);
      const hub = await makeHub(olivia);
      await expect(
        admin.query(
          `INSERT INTO hub_organization (hub_id, organization_id, hub_owner_user_id, requested_by_user_id,
             owner_approved_by_user_id, owner_approved_at)
           VALUES ($1, $2, $3, $4, $4, now())`,
          [hub.id, orgA.id, olivia, ana],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('the denormalized hub owner cannot be forged (composite FK to hubs)', async () => {
      const olivia = await makeUser('olivia@x.com');
      const ana = await makeUser('ana@x.com');
      const orgA = await makeOrg('A', [ana]);
      const hub = await makeHub(olivia);
      await expect(
        asApp(
          { organizationId: orgA.id, userId: ana },
          `INSERT INTO hub_organization (hub_id, organization_id, hub_owner_user_id, requested_by_user_id)
           VALUES ($1, $2, $3, $3)`,
          [hub.id, orgA.id, ana],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  describe('hub roles (role_assignments, scope hub)', () => {
    it('only the owner writes; each person reads the own row; the hub reads its rows', async () => {
      const olivia = await makeUser('olivia@x.com');
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const orgA = await makeOrg('A', [olivia], [ana, bob]);
      const hub = await makeHub(olivia);
      await link(hub, orgA.id);

      await as({ userId: olivia }, () =>
        hubRoles.assign({
          hubId: hub.id,
          userId: ana,
          roleKey: 'hub_operator',
        }),
      );
      // Idempotente e troca o papel, na mesma linha.
      await as({ userId: olivia }, () =>
        hubRoles.assign({ hubId: hub.id, userId: ana, roleKey: 'hub_user' }),
      );
      expect(await as({ userId: olivia }, () => hubRoles.list(hub.id))).toEqual(
        [{ hubId: hub.id, userId: ana, roleKey: 'hub_user' }],
      );

      // Ana (não dona) não atribui papel a Bob.
      await expect(
        as({ userId: ana }, () =>
          hubRoles.assign({
            hubId: hub.id,
            userId: bob,
            roleKey: 'hub_operator',
          }),
        ),
      ).rejects.toMatchObject({ driverError: { code: '42501' } });
      // Nem o contexto da organização abre as linhas de Hub (organization_id nulo).
      expect(
        await asApp(
          { organizationId: orgA.id },
          `SELECT id FROM role_assignments WHERE scope_type = 'hub'`,
        ),
      ).toEqual([]);

      // Cada pessoa lê a própria linha; Bob não vê a da Ana.
      expect(
        await asApp(
          { userId: ana },
          `SELECT user_id FROM role_assignments WHERE scope_type = 'hub'`,
        ),
      ).toEqual([{ user_id: ana }]);
      expect(
        await asApp(
          { userId: bob },
          `SELECT user_id FROM role_assignments WHERE scope_type = 'hub'`,
        ),
      ).toEqual([]);
      // O Hub lê as linhas dele (e não as de outro Hub).
      expect(
        await as({ hubId: hub.id }, () => hubRoles.list(hub.id)),
      ).toHaveLength(1);
      expect(await as({ hubId: newId() }, () => hubRoles.list(hub.id))).toEqual(
        [],
      );

      // Remover é lápide; atribuir de novo revive a mesma linha.
      await as({ userId: olivia }, () => hubRoles.remove(hub.id, ana));
      expect(await as({ userId: olivia }, () => hubRoles.list(hub.id))).toEqual(
        [],
      );
      await as({ userId: olivia }, () =>
        hubRoles.assign({
          hubId: hub.id,
          userId: ana,
          roleKey: 'hub_operator',
        }),
      );
      const rows: { n: number }[] = await admin.query(
        `SELECT count(*)::int AS n FROM role_assignments WHERE scope_type = 'hub' AND hub_id = $1 AND user_id = $2`,
        [hub.id, ana],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('the hub context only tombstones assignable roles: no revive, no role change, no system rows', async () => {
      const olivia = await makeUser('olivia@x.com');
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const orgA = await makeOrg('A', [olivia], [ana, bob]);
      const hub = await makeHub(olivia);
      await link(hub, orgA.id);
      const [{ id: ownerRole }] = (await admin.query(
        `SELECT id FROM roles WHERE key = 'hub_owner' AND organization_id IS NULL`,
      )) as { id: string }[];
      await admin.query(
        `INSERT INTO role_assignments (role_id, user_id, scope_type, hub_id) VALUES ($1, $2, 'hub', $3)`,
        [ownerRole, olivia, hub.id],
      );
      for (const [u, role] of [
        [ana, 'hub_user'],
        [bob, 'hub_user'],
      ] as const) {
        await as({ userId: olivia }, () =>
          hubRoles.assign({ hubId: hub.id, userId: u, roleKey: role }),
        );
      }
      await as({ userId: olivia }, () => hubRoles.remove(hub.id, bob));
      const ctx = { hubId: hub.id };
      const sql = (set: string, userId: string) =>
        asApp(
          ctx,
          `UPDATE role_assignments SET ${set} WHERE scope_type = 'hub' AND hub_id = $1 AND user_id = $2 RETURNING id`,
          [hub.id, userId],
        );
      // Reviver a lápide de Bob: a lápide nem é alcançável pelo Hub (USING só pega linha viva).
      expect(await sql('deleted_at = NULL', bob)).toEqual([[], 0]);
      // Trocar o papel de Ana (sem lápide), nem para hub_owner: recusado.
      await expect(sql(`role_id = '${ownerRole}'`, ana)).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        sql(`role_id = role_id, updated_at = now()`, ana),
      ).rejects.toMatchObject({ code: '42501' });
      // Nem lápide virando hub_owner.
      await expect(
        sql(`deleted_at = now(), role_id = '${ownerRole}'`, ana),
      ).rejects.toMatchObject({ code: '42501' });
      // A linha de sistema (hub_owner da dona) nem é alcançável.
      expect(await sql('deleted_at = now()', olivia)).toEqual([[], 0]);
      // Lápide de papel atribuível: permitida, uma vez; uma lápide não é mais alcançável pelo Hub.
      expect((await sql('deleted_at = now()', ana))[1]).toBe(1);
      expect(await sql('deleted_at = now()', ana)).toEqual([[], 0]);
      expect(await sql('deleted_at = now()', bob)).toEqual([[], 0]);
      // A dona revive normalmente; um sistema já ocupado dá 409 estável.
      await as({ userId: olivia }, () =>
        hubRoles.assign({
          hubId: hub.id,
          userId: ana,
          roleKey: 'hub_operator',
        }),
      );
      await expect(
        as({ userId: olivia }, () =>
          hubRoles.assign({
            hubId: hub.id,
            userId: olivia,
            roleKey: 'hub_user',
          }),
        ),
      ).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'hub-system-role',
      });
    });

    it('removeUsersWithoutLinkedOrg tombstones only people without any approved linked organization', async () => {
      const olivia = await makeUser('olivia@x.com');
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const cid = await makeUser('cid@x.com');
      const orgA = await makeOrg('A', [olivia], [ana, bob]);
      const orgB = await makeOrg('B', [cid], [bob]);
      const hub = await makeHub(olivia);
      await link(hub, orgA.id);
      await link(hub, orgB.id);
      for (const u of [ana, bob, cid]) {
        await as({ userId: olivia }, () =>
          hubRoles.assign({ hubId: hub.id, userId: u, roleKey: 'hub_user' }),
        );
      }
      // A é desvinculada: Ana fica sem organização vinculada; Bob continua pela B; Cid é da B.
      const a = (await as({ userId: olivia }, () =>
        links.find(hub.id, orgA.id),
      ))!;
      a.revoke();
      await as({ userId: olivia }, () => links.upsert(a));
      // Cascata de um admin (não dono): roda no contexto do Hub.
      const removed = await as({ userId: cid, hubId: hub.id }, () =>
        hubRoles.removeUsersWithoutLinkedOrg(hub.id),
      );
      expect(removed).toEqual([ana]);
      expect(
        (await as({ userId: olivia }, () => hubRoles.list(hub.id)))
          .map((r) => r.userId)
          .sort(),
      ).toEqual([bob, cid].sort());
    });

    it('CHECKs: a hub row has hub_id and no organization_id; only hub rows carry hub_id', async () => {
      const olivia = await makeUser('olivia@x.com');
      const orgA = await makeOrg('A', [olivia]);
      const hub = await makeHub(olivia);
      const [{ id: roleId }] = (await admin.query(
        `SELECT id FROM roles WHERE key = 'hub_user' AND organization_id IS NULL`,
      )) as { id: string }[];
      await expect(
        admin.query(
          `INSERT INTO role_assignments (role_id, user_id, scope_type, organization_id, hub_id)
           VALUES ($1, $2, 'hub', $3, $4)`,
          [roleId, olivia, orgA.id, hub.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        admin.query(
          `INSERT INTO role_assignments (role_id, user_id, scope_type, organization_id, hub_id)
           VALUES ($1, $2, 'organization', $3, $4)`,
          [roleId, olivia, orgA.id, hub.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('backend-only tables: conditional single use', () => {
    const enrollment = async (code = 'c1') => {
      const identity = await createHubIdentity();
      return Enrollment.issue({
        keys: identity,
        nonce: b64(16),
        codeHash: hex(code),
        now,
      });
    };

    it('enrollments: create, find, concurrent markClaimed has one winner, expireStale flags expired ones', async () => {
      const olivia = await makeUser('olivia@x.com');
      const hub = await makeHub(olivia);
      const e = await enrollment('c1');
      await enrollments.create(e);
      expect((await enrollments.findById(e.id))?.claimCodeHash).toBe(hex('c1'));
      expect((await enrollments.findPendingByCodeHash(hex('c1')))?.id).toBe(
        e.id,
      );
      // Mesma chave e nonce: recusado (nonce de uso único).
      const replay = Enrollment.restore(
        {
          signingPublicKey: e.signingPublicKey,
          encryptionPublicKey: e.encryptionPublicKey,
          nonce: e.nonce,
          claimCodeHash: hex('c9'),
          expiresAt: e.expiresAt,
          status: 'pending',
          claimedHubId: null,
          createdAt: now,
        },
        newId(),
      );
      await expect(enrollments.create(replay)).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'nonce-reused',
      });
      // Outra apresentação pendente com o mesmo hash de código: colisão (o caso de uso sorteia outro código).
      await expect(
        enrollments.create(await enrollment('c1')),
      ).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'claim-code-collision',
      });

      const results = await Promise.all([
        enrollments.markClaimed(e.id, hub.id, later(1)),
        enrollments.markClaimed(e.id, hub.id, later(1)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const claimed = await enrollments.findById(e.id);
      expect([claimed?.status, claimed?.claimedHubId]).toEqual([
        'claimed',
        hub.id,
      ]);
      expect(await enrollments.findPendingByCodeHash(hex('c1'))).toBeNull();

      // Vencida não é reivindicada, mesmo pendente.
      const late = await enrollment('c4');
      await enrollments.create(late);
      expect(
        await enrollments.markClaimed(late.id, hub.id, late.expiresAt),
      ).toBe(false);
      await admin.query(
        `UPDATE hub_enrollments SET status = 'expired' WHERE id = $1`,
        [late.id],
      );

      const stale = await enrollment('c2');
      const fresh = await enrollment('c3');
      await enrollments.create(stale);
      await enrollments.create(fresh);
      expect(await enrollments.expireStale(later(10 * 60 * 1000))).toBe(2);
      expect((await enrollments.findById(stale.id))?.status).toBe('expired');
      expect(await enrollments.expireStale(later(10 * 60 * 1000))).toBe(0);
    });

    it('link codes: concurrent consume has one winner; used, expired and unknown give null', async () => {
      const olivia = await makeUser('olivia@x.com');
      const hub = await makeHub(olivia);
      const code = LinkCode.issue({ hubId: hub.id, codeHash: hex('l1'), now });
      await linkCodes.create(code);
      const results = await Promise.all([
        linkCodes.consume(hex('l1'), later(1)),
        linkCodes.consume(hex('l1'), later(1)),
        linkCodes.consume(hex('l1'), later(1)),
      ]);
      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.hubId).toBe(hub.id);
      expect(winners[0]!.usedAt?.toISOString()).toBe(later(1).toISOString());
      expect(await linkCodes.consume(hex('l1'), later(2))).toBeNull();
      expect(await linkCodes.consume(hex('zz'), later(2))).toBeNull();
      const expiring = LinkCode.issue({
        hubId: hub.id,
        codeHash: hex('l2'),
        now,
      });
      await linkCodes.create(expiring);
      expect(await linkCodes.consume(hex('l2'), expiring.expiresAt)).toBeNull();
      // O hash só é único entre os vigentes (used_at nulo): depois de usado, um código novo pode repeti-lo.
      expect(await linkCodes.consume(hex('l2'), later(1))).not.toBeNull();
      await linkCodes.create(
        LinkCode.issue({ hubId: hub.id, codeHash: hex('l2'), now }),
      );

      // Vencido e não usado segura o hash até expireStale; depois o hash fica livre.
      const stale = LinkCode.issue({ hubId: hub.id, codeHash: hex('l3'), now });
      await linkCodes.create(stale);
      await expect(
        linkCodes.create(
          LinkCode.issue({ hubId: hub.id, codeHash: hex('l3'), now }),
        ),
      ).rejects.toMatchObject({ code: 'link-code-collision' });
      // l2 (novo, vigente até now + 10 min) e l3 vencem; os usados não contam.
      expect(await linkCodes.expireStale(stale.expiresAt)).toBe(2);
      expect(await linkCodes.expireStale(stale.expiresAt)).toBe(0);
      expect(await linkCodes.consume(hex('l3'), later(1))).toBeNull();
      await linkCodes.create(
        LinkCode.issue({ hubId: hub.id, codeHash: hex('l3'), now: later(1) }),
      );
    });

    it('auth challenges: concurrent consume has one winner; the decoy never validates', async () => {
      const olivia = await makeUser('olivia@x.com');
      const hub = await makeHub(olivia);
      const real = {
        id: newId(),
        hubId: hub.id,
        challengeHash: hex('a1'),
        expiresAt: later(60_000),
        usedAt: null,
      };
      await challenges.create(real);
      const decoy = {
        ...real,
        id: newId(),
        hubId: null,
        challengeHash: hex('a2'),
      };
      await challenges.create(decoy);

      expect(await challenges.consume(newId(), hex('a1'), later(1))).toBeNull();
      const results = await Promise.all([
        challenges.consume(hub.id, hex('a1'), later(1)),
        challenges.consume(hub.id, hex('a1'), later(1)),
      ]);
      expect(results.filter((r) => r !== null).map((r) => r!.id)).toEqual([
        real.id,
      ]);
      expect(await challenges.consume(hub.id, hex('a1'), later(2))).toBeNull();
      expect(await challenges.consume(hub.id, hex('a2'), later(1))).toBeNull();

      const expiring = { ...real, id: newId(), challengeHash: hex('a3') };
      await challenges.create(expiring);
      expect(
        await challenges.consume(hub.id, hex('a3'), expiring.expiresAt),
      ).toBeNull();
    });
  });

  describe('hub_space', () => {
    it('the composite FK refuses a space of another organization; add/remove/revive in the organization scope', async () => {
      const olivia = await makeUser('olivia@x.com');
      const ana = await makeUser('ana@x.com');
      const bob = await makeUser('bob@x.com');
      const orgA = await makeOrg('A', [olivia], [ana]);
      const orgB = await makeOrg('B', [bob]);
      const spaceA = await makeSpace(orgA.id);
      const hub = await makeHub(olivia);
      const ref0 = {
        hubId: hub.id,
        spaceId: spaceA.id,
        organizationId: orgA.id,
        addedByUserId: olivia,
      };
      // Sem vínculo do Hub com a A, o espaço não entra (guarda do repositório e FK composta para o vínculo).
      await expect(
        as({ userId: olivia }, () => hubSpaces.add(ref0)),
      ).rejects.toMatchObject({
        constructor: NotFoundError,
        code: 'hub-not-found',
      });
      await expect(
        asApp(
          { organizationId: orgA.id },
          `INSERT INTO hub_space (hub_id, space_id, organization_id, added_by_user_id) VALUES ($1, $2, $3, $4)`,
          [hub.id, spaceA.id, orgA.id, olivia],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await link(hub, orgA.id);

      // B tenta apontar para o espaço da A (FK ignora o RLS, por isso é composta).
      await expect(
        asApp(
          { organizationId: orgB.id },
          `INSERT INTO hub_space (hub_id, space_id, organization_id, added_by_user_id) VALUES ($1, $2, $3, $4)`,
          [hub.id, spaceA.id, orgB.id, bob],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        as({ userId: bob }, () =>
          hubSpaces.add({
            hubId: hub.id,
            spaceId: spaceA.id,
            organizationId: orgB.id,
            addedByUserId: bob,
          }),
        ),
      ).rejects.toMatchObject({
        constructor: NotFoundError,
        code: 'space-not-found',
      });

      const ref = {
        hubId: hub.id,
        spaceId: spaceA.id,
        organizationId: orgA.id,
        addedByUserId: olivia,
      };
      await as({ userId: olivia }, () => hubSpaces.add(ref));
      await as({ userId: olivia }, () => hubSpaces.add(ref));
      expect(
        await as({ userId: olivia }, () => hubSpaces.list(hub.id)),
      ).toEqual([ref]);
      expect(await as({ hubId: hub.id }, () => hubSpaces.list(hub.id))).toEqual(
        [ref],
      );
      // Membro sem o escopo da organização não lê hub_space (sem policy de membro); com o escopo, lê.
      expect(await as({ userId: ana }, () => hubSpaces.list(hub.id))).toEqual(
        [],
      );
      expect(
        await as({ userId: ana, organizationId: orgA.id }, () =>
          hubSpaces.list(hub.id),
        ),
      ).toEqual([ref]);
      expect(await as({ userId: bob }, () => hubSpaces.list(hub.id))).toEqual(
        [],
      );
      expect(
        await asApp(
          { organizationId: orgB.id },
          `SELECT hub_id FROM hub_space`,
        ),
      ).toEqual([]);

      await as({ userId: ana, organizationId: orgA.id }, () =>
        hubSpaces.remove(hub.id, spaceA.id, orgA.id),
      );
      expect(
        await as({ userId: olivia }, () => hubSpaces.list(hub.id)),
      ).toEqual([]);
      await as({ userId: ana }, () =>
        hubSpaces.add({ ...ref, addedByUserId: ana }),
      );
      expect(
        await as({ userId: olivia }, () => hubSpaces.list(hub.id)),
      ).toEqual([{ ...ref, addedByUserId: ana }]);
      const rows: { n: number }[] = await admin.query(
        `SELECT count(*)::int AS n FROM hub_space WHERE hub_id = $1`,
        [hub.id],
      );
      expect(rows[0]!.n).toBe(1);

      // Vínculo revogado ou pendente: o Hub deixa de ver o hub_space (a dona ainda vê).
      const a = (await as({ userId: olivia }, () =>
        links.find(hub.id, orgA.id),
      ))!;
      a.revoke();
      await as({ userId: olivia }, () => links.upsert(a));
      expect(await as({ hubId: hub.id }, () => hubSpaces.list(hub.id))).toEqual(
        [],
      );
      await link(hub, orgA.id, 'pending');
      expect(await as({ hubId: hub.id }, () => hubSpaces.list(hub.id))).toEqual(
        [],
      );
      expect(
        await as({ userId: olivia }, () => hubSpaces.list(hub.id)),
      ).toHaveLength(1);
    });
  });

  describe('schema', () => {
    it('sync_version on hubs, hub_organization and hub_space, not on the backend-only tables', async () => {
      const rows: { table_name: string }[] = await admin.query(
        `SELECT table_name FROM information_schema.columns
          WHERE column_name = 'sync_version' AND table_name = ANY($1) ORDER BY table_name`,
        [[...HUB_TABLES]],
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        'hub_organization',
        'hub_space',
        'hubs',
      ]);
    });

    it('the existing hub columns now point at hubs (space_key_grants.hub_id, role_assignments.room_hub_id / hub_id)', async () => {
      const rows: { conname: string }[] = await admin.query(
        `SELECT conname FROM pg_constraint
          WHERE contype = 'f' AND confrelid = 'hubs'::regclass ORDER BY conname`,
      );
      expect(rows.map((r) => r.conname)).toEqual(
        expect.arrayContaining([
          'fk_space_key_grants_hubs',
          'fk_role_assignments_room_hub',
          'fk_role_assignments_hubs',
          'fk_hub_organization_hubs',
          'fk_hub_space_hubs',
        ]),
      );
    });

    it('the runtime role cannot DELETE from the hub tables', async () => {
      for (const t of HUB_TABLES) {
        await expect(asApp({}, `DELETE FROM ${t}`)).rejects.toMatchObject({
          code: '42501',
        });
      }
    });

    it('the policies compose without recursion under every context', async () => {
      const olivia = await makeUser('olivia@x.com');
      const orgA = await makeOrg('A', [olivia]);
      const hub = await makeHub(olivia);
      await link(hub, orgA.id);
      const contexts: UnitOfWorkContext[] = [
        {},
        { userId: olivia },
        { hubId: hub.id },
        { organizationId: orgA.id },
        { userId: olivia, hubId: hub.id, organizationId: orgA.id },
      ];
      for (const ctx of contexts) {
        for (const t of [
          'hubs',
          'hub_organization',
          'hub_space',
          'role_assignments',
          'organizations',
          'spaces',
        ]) {
          await expect(
            asApp(ctx, `SELECT count(*) FROM ${t}`),
          ).resolves.toBeDefined();
        }
      }
      expect(
        ids(await asApp({ userId: olivia }, `SELECT id FROM hubs`)),
      ).toEqual([hub.id]);
    });
  });
});
