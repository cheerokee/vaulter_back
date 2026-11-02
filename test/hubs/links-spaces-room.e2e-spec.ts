import type { INestApplication } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';
import { AuthenticateHubTokenUseCase } from '../../src/hubs/application/authenticate-hub-token.use-case.js';
import { HubRoleRepository } from '../../src/hubs/domain/hub-role.repository.js';
import { HubTokenService } from '../../src/identity/application/hub-token-service.js';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../src/shared/domain/errors.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  hubDeregistered,
  hubSpaceRows,
  hubsKit,
  linkRow,
  liveHubRoles,
} from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
  recipientOf,
} from '../support/identity-client.js';
import {
  auditRows,
  hubRoom,
  hubWrappedKey,
  spaceRow,
} from '../support/spaces-db.js';

const err = (constructor: unknown, code: string) => ({ constructor, code });
const HUB_404 = err(NotFoundError, 'hub-not-found');
const DENIED = err(PermissionDeniedError, 'permission-denied');
const ORG_404 = err(NotFoundError, 'organization-not-found');

/** True once `p` settles; used to prove a call is blocked on a lock. */
function settledFlag(p: Promise<unknown>): () => boolean {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  return () => done;
}
/** Same order as `ORDER BY space_id` (lowercase hex UUIDs compare like the database). */
const byFirst = (x: unknown[], y: unknown[]) =>
  String(x[0]) < String(y[0]) ? -1 : 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Vínculos, espaços no Hub, Sala, papéis, desregistro e os ganchos (spec hubs §4, §6 e §7), pelos casos de uso no
// app Nest (papel de runtime, RLS valendo) e com a cripto real do Hub e do cliente.
describe('hub links, hub spaces, Room, roles and deregistration (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  const c = identityClient(() => app);
  const s = c.spaces;
  const k = hubsKit(() => app);
  const auth = (u: KeyedUser) => ({ Authorization: `Bearer ${u.token}` });

  let olivia: KeyedUser; // dona dos Hubs
  let ana: KeyedUser;
  let bia: KeyedUser;
  let carl: KeyedUser; // estranho

  const setPolicy = (by: KeyedUser, orgId: string, body: object) =>
    expectStatus(
      c.http().patch(`/organizations/${orgId}`).set(auth(by)).send(body),
      200,
    );
  /** Organization created by `creator` (its admin), with a kit, and `members` joined as org_member. */
  const org = async (
    creator: KeyedUser,
    name: string,
    members: KeyedUser[] = [],
  ) => {
    const { orgId, kit } = await s.orgWithKit(creator, name);
    for (const u of members) await s.joinOrg(creator, orgId, u);
    return { orgId, kit };
  };
  /** Space created by `creator` (Gestor), with `editors` and extra `managers` added; keys[i] = version i + 1. */
  const space = async (
    creator: KeyedUser,
    orgId: string,
    kitPublicKey: string,
    editors: KeyedUser[] = [],
    managers: KeyedUser[] = [],
  ) => {
    const sp = await s.create(creator, orgId, kitPublicKey, `S-${newId()}`);
    expect(sp.res.status).toBe(201);
    const add = (u: KeyedUser, roleKey: string) =>
      expectStatus(
        s.addMember(
          creator.token,
          sp.spaceId,
          recipientOf(u),
          [sp.key],
          roleKey,
        ),
        201,
      );
    for (const u of editors) await add(u, 'space_editor');
    for (const u of managers) await add(u, 'space_manager');
    return { spaceId: sp.spaceId, keys: [sp.key] };
  };
  /** A hub of Olivia linked (approved) to an org she administers, with one space on the hub. */
  const hubWithSpace = async (name: string, editors: KeyedUser[] = []) => {
    const o = await org(olivia, name, editors);
    const hub = await k.claim(olivia);
    await k.link(olivia, hub.hubId, o.orgId);
    const sp = await space(olivia, o.orgId, o.kit.publicKey, editors);
    await k.addSpace(olivia, hub.hubId, sp.spaceId);
    return { ...o, hub, ...sp };
  };
  /** Owner-role transaction holding `sql` (a lock) until released; ALWAYS release it in `finally`. */
  const hold = async (sql: string, params: unknown[]) => {
    const qr: QueryRunner = admin.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    await qr.query(sql, params);
    return {
      qr,
      release: async () => {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        if (!qr.isReleased) await qr.release();
      },
      commit: async () => {
        if (qr.isTransactionActive) await qr.commitTransaction();
        if (!qr.isReleased) await qr.release();
      },
    };
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    admin = await adminDataSource();
    olivia = await s.signUpKeyed('hl-olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('hl-ana@example.com', 'Ana');
    bia = await s.signUpKeyed('hl-bia@example.com', 'Bia');
    carl = await s.signUpKeyed('hl-carl@example.com', 'Carl');
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  describe('claim', () => {
    it('always approves the personal-org link, with both consents by the owner, even under admin_approved', async () => {
      const personal: { id: string }[] = await admin.query(
        `SELECT id FROM organizations WHERE personal_owner_user_id = $1`,
        [bia.userId],
      );
      const personalId = personal[0]!.id;
      await setPolicy(bia, personalId, { hubLinkPolicy: 'admin_approved' });
      const hub = await k.claim(bia);
      expect(await linkRow(hub.hubId, personalId)).toMatchObject({
        status: 'approved',
        owner_approved_by_user_id: bia.userId,
        org_approved_by_user_id: bia.userId,
      });
    });
  });

  describe('links', () => {
    it('owner link: approved at once under any_member_hub; pending under admin_approved until an admin approves', async () => {
      const hub = await k.claim(olivia);
      const open = await org(olivia, 'Open Org');
      await expect(
        k.link(olivia, hub.hubId, open.orgId),
      ).resolves.toMatchObject({
        status: 'approved',
        organizationId: open.orgId,
      });
      await expect(k.link(olivia, hub.hubId, open.orgId)).rejects.toMatchObject(
        err(ConflictError, 'already-linked'),
      );

      // Ana administra a organização; Olivia é só membro.
      const strict = await org(ana, 'Strict Org', [olivia, bia]);
      await setPolicy(ana, strict.orgId, { hubLinkPolicy: 'admin_approved' });
      await expect(
        k.link(olivia, hub.hubId, strict.orgId),
      ).resolves.toMatchObject({ status: 'pending' });
      // um membro sem org.hubs.approve: 403; um estranho: 404
      await expect(
        k.approve(bia, hub.hubId, strict.orgId),
      ).rejects.toMatchObject(DENIED);
      await expect(
        k.approve(carl, hub.hubId, strict.orgId),
      ).rejects.toMatchObject(ORG_404);
      // Ana ainda não vê o Hub (vínculo pendente), mas aprova como admin
      expect(await k.access(ana, hub.hubId)).toBeNull();
      await expect(
        k.approve(ana, hub.hubId, strict.orgId),
      ).resolves.toMatchObject({ status: 'approved' });
      expect(await linkRow(hub.hubId, strict.orgId)).toMatchObject({
        status: 'approved',
        owner_approved_by_user_id: olivia.userId,
        org_approved_by_user_id: ana.userId,
      });
      expect((await k.access(ana, hub.hubId))?.role).toBe('hub_user');

      // só o dono vincula; e só uma organização de que ele é membro
      await expect(k.link(ana, hub.hubId, strict.orgId)).rejects.toMatchObject(
        DENIED,
      );
      await expect(k.link(carl, hub.hubId, open.orgId)).rejects.toMatchObject(
        HUB_404,
      );
      const carlOrg = await org(carl, 'Carl Org');
      await expect(
        k.link(olivia, hub.hubId, carlOrg.orgId),
      ).rejects.toMatchObject(ORG_404);

      const audits = await auditRows(strict.orgId, 'hub.organization.');
      expect(audits.map((a) => [a.action, a.user_id, a.metadata])).toEqual([
        [
          'hub.organization.requested',
          olivia.userId,
          { hubId: hub.hubId, by: 'owner', status: 'pending' },
        ],
        [
          'hub.organization.approved',
          ana.userId,
          { hubId: hub.hubId, as: 'admin', status: 'approved' },
        ],
      ]);
    });

    it('link code: invalid code, non-member, single use; the owner approves, and an admin too under admin_approved', async () => {
      const hub = await k.claim(olivia);
      const acme = await org(ana, 'Code Org', [bia]);
      await expect(k.request(bia, '1234567', acme.orgId)).rejects.toMatchObject(
        err(DomainValidationError, 'link-code-invalid'),
      );
      await expect(
        k.request(bia, '00000000', acme.orgId),
      ).rejects.toMatchObject(err(DomainValidationError, 'link-code-invalid'));

      const { linkCode, expiresAt } = await k.linkCode(hub.hubId);
      expect(linkCode).toMatch(/^[0-9]{8}$/);
      expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
      // quem não é membro da organização não gasta o código
      await expect(k.request(carl, linkCode, acme.orgId)).rejects.toMatchObject(
        ORG_404,
      );
      const view = await k.request(bia, linkCode, acme.orgId);
      expect(view).toEqual({ organizationId: acme.orgId, status: 'pending' });
      expect(view).not.toHaveProperty('hubId');
      await expect(k.request(bia, linkCode, acme.orgId)).rejects.toMatchObject(
        err(DomainValidationError, 'link-code-invalid'),
      );
      const stored: { code_hash: string }[] = await admin.query(
        `SELECT code_hash FROM hub_link_codes WHERE hub_id = $1`,
        [hub.hubId],
      );
      expect(stored[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/);

      // any_member_hub: só o dono aprova
      await expect(
        k.approve(olivia, hub.hubId, acme.orgId),
      ).resolves.toMatchObject({ status: 'approved' });

      // admin_approved: o dono aprova e continua pendente; o admin resolve
      const strict = await org(ana, 'Code Strict', [bia]);
      await setPolicy(ana, strict.orgId, { hubLinkPolicy: 'admin_approved' });
      const code2 = (await k.linkCode(hub.hubId)).linkCode;
      await k.request(bia, code2, strict.orgId);
      await expect(
        k.approve(olivia, hub.hubId, strict.orgId),
      ).resolves.toMatchObject({ status: 'pending' });
      await expect(
        k.approve(ana, hub.hubId, strict.orgId),
      ).resolves.toMatchObject({ status: 'approved' });
      expect(await auditRows(acme.orgId, 'hub.organization.requested')).toEqual(
        [
          {
            action: 'hub.organization.requested',
            user_id: bia.userId,
            metadata: {
              hubId: hub.hubId,
              by: 'member',
              via: 'link_code',
              status: 'pending',
            },
          },
        ],
      );
    });

    it('a stale code is tombstoned before a new one is issued; a deregistered hub code is the same invalid code', async () => {
      const hub = await k.claim(olivia);
      const stale = await k.linkCode(hub.hubId);
      await admin.query(
        `UPDATE hub_link_codes SET expires_at = now() - interval '1 minute' WHERE hub_id = $1`,
        [hub.hubId],
      );
      await k.linkCode(hub.hubId);
      const rows: { live: boolean }[] = await admin.query(
        `SELECT deleted_at IS NULL AS live FROM hub_link_codes WHERE hub_id = $1 ORDER BY created_at`,
        [hub.hubId],
      );
      expect(rows.map((r) => r.live)).toEqual([false, true]);
      const acme = await org(ana, 'Stale Org', [bia]);
      await expect(
        k.request(bia, stale.linkCode, acme.orgId),
      ).rejects.toMatchObject(err(DomainValidationError, 'link-code-invalid'));

      const fresh = await k.linkCode(hub.hubId);
      await k.deregister(olivia, hub.hubId);
      await expect(
        k.request(bia, fresh.linkCode, acme.orgId),
      ).rejects.toMatchObject(err(DomainValidationError, 'link-code-invalid'));
    });

    it('re-settles a pending link with the CURRENT policy when the org relaxes to any_member_hub (owner route and admin route)', async () => {
      const hub = await k.claim(olivia);
      const a = await org(ana, 'Relax A', [olivia]);
      const b = await org(ana, 'Relax B', [olivia]);
      for (const o of [a, b]) {
        await setPolicy(ana, o.orgId, { hubLinkPolicy: 'admin_approved' });
        await expect(k.link(olivia, hub.hubId, o.orgId)).resolves.toMatchObject(
          { status: 'pending' },
        );
        await setPolicy(ana, o.orgId, { hubLinkPolicy: 'any_member_hub' });
        // a mudança de política não resolve sozinha
        expect((await linkRow(hub.hubId, o.orgId))?.status).toBe('pending');
      }
      // o dono já tinha consentido: aprovar de novo resolve com a política atual
      await expect(
        k.approve(olivia, hub.hubId, a.orgId),
      ).resolves.toMatchObject({ status: 'approved' });
      expect((await linkRow(hub.hubId, a.orgId))?.org_approved_by_user_id).toBe(
        null,
      );
      // pela rota do admin também
      await expect(k.approve(ana, hub.hubId, b.orgId)).resolves.toMatchObject({
        status: 'approved',
      });
    });

    it('concurrent owner and admin approvals both count (the link row is locked FOR UPDATE)', async () => {
      const hub = await k.claim(olivia);
      const strict = await org(ana, 'Race Org', [bia]);
      await setPolicy(ana, strict.orgId, { hubLinkPolicy: 'admin_approved' });
      await k.request(
        bia,
        (await k.linkCode(hub.hubId)).linkCode,
        strict.orgId,
      );
      await Promise.all([
        k.approve(olivia, hub.hubId, strict.orgId),
        k.approve(ana, hub.hubId, strict.orgId),
      ]);
      expect(await linkRow(hub.hubId, strict.orgId)).toMatchObject({
        status: 'approved',
        owner_approved_by_user_id: olivia.userId,
        org_approved_by_user_id: ana.userId,
      });
    });

    it('reject: owner or admin, only a pending request; a rejected link can start over', async () => {
      const hub = await k.claim(olivia);
      const acme = await org(ana, 'Reject Org', [bia, olivia]);
      await k.request(bia, (await k.linkCode(hub.hubId)).linkCode, acme.orgId);
      await expect(k.reject(bia, hub.hubId, acme.orgId)).rejects.toMatchObject(
        DENIED,
      );
      await expect(k.reject(ana, hub.hubId, acme.orgId)).resolves.toMatchObject(
        { status: 'rejected' },
      );
      await expect(
        k.reject(olivia, hub.hubId, acme.orgId),
      ).rejects.toMatchObject(err(ConflictError, 'link-not-pending'));
      await expect(
        k.link(olivia, hub.hubId, acme.orgId),
      ).resolves.toMatchObject({ status: 'approved' });
      expect(
        (await auditRows(acme.orgId, 'hub.organization.rejected')).map(
          (a) => a.user_id,
        ),
      ).toEqual([ana.userId]);
    });

    it('unlink (owner or org admin) removes the org spaces, the Room and its copies, marks the rotation and drops roles of users left without a linked org', async () => {
      const hub = await k.claim(olivia);
      // Org A (admin Ana): Olivia e Bia membros. Org B (admin Olivia): Bia membro.
      const a = await org(ana, 'Unlink A', [olivia, bia]);
      const b = await org(olivia, 'Unlink B', [bia, carl]);
      await k.link(olivia, hub.hubId, a.orgId);
      await k.link(olivia, hub.hubId, b.orgId);
      // Olivia é só membro de A: a Ana cria o espaço e a põe como Gestora
      const sp = await space(ana, a.orgId, a.kit.publicKey, [], [olivia]);
      await k.addSpace(olivia, hub.hubId, sp.spaceId);
      await k.grantRoom(olivia, hub, sp.spaceId, a.kit.publicKey, sp.keys);
      expect((await hubRoom(sp.spaceId, hub.hubId)).versions).toEqual([1]);
      await k.assignRole(olivia, hub.hubId, bia.userId, 'hub_operator');
      await k.assignRole(olivia, hub.hubId, ana.userId, 'hub_user');
      await k.assignRole(olivia, hub.hubId, carl.userId, 'hub_user');

      // quem não é dono nem admin de A: Bia (membro) 403, Carl (fora de A) 404
      await expect(k.unlink(bia, hub.hubId, a.orgId)).rejects.toMatchObject(
        DENIED,
      );
      await expect(k.unlink(carl, hub.hubId, a.orgId)).rejects.toMatchObject(
        ORG_404,
      );

      // Ana (admin de A, não dona do Hub) desvincula A
      await k.unlink(ana, hub.hubId, a.orgId);
      expect((await linkRow(hub.hubId, a.orgId))?.status).toBe('revoked');
      expect(await hubSpaceRows(hub.hubId)).toEqual([[sp.spaceId, false]]);
      expect(await hubRoom(sp.spaceId, hub.hubId)).toEqual({
        roleKey: null,
        versions: [],
        tombstoned: 1,
      });
      expect((await spaceRow(sp.spaceId)).key_rotation_required).toBe(true);
      // Ana ficou sem organização vinculada: perde o papel; Bia e Carl seguem por B
      expect(await liveHubRoles(hub.hubId)).toEqual(
        [
          ['hub_operator', bia.userId],
          ['hub_owner', olivia.userId],
          ['hub_room', 'room'],
          ['hub_user', carl.userId],
        ].sort((x, y) => (x.join() < y.join() ? -1 : 1)),
      );
      expect(await k.access(ana, hub.hubId)).toBeNull();
      const audits = await auditRows(a.orgId, 'hub.');
      expect(audits.map((x) => x.action)).toEqual(
        expect.arrayContaining([
          'hub.room.revoked',
          'hub.organization.revoked',
          'hub.space.removed',
          'hub.role.changed',
        ]),
      );
      const revoked = audits.find(
        (x) => x.action === 'hub.organization.revoked',
      )!;
      expect(revoked.user_id).toBe(ana.userId);
      expect(revoked.metadata).toEqual({
        hubId: hub.hubId,
        reason: 'unlinked',
        spaceIds: [sp.spaceId],
        roomSpaceIds: [sp.spaceId],
      });
      // nenhuma auditoria leva cópia trancada (108 caracteres base64url) nem campo de chave
      expect(JSON.stringify(audits)).not.toMatch(
        /wrappedKey|wrapped_key|[A-Za-z0-9_-]{108}/,
      );

      // o dono desvincula B: Bia e Carl ficam sem organização vinculada
      await k.unlink(olivia, hub.hubId, b.orgId);
      expect(await liveHubRoles(hub.hubId)).toEqual([
        ['hub_owner', olivia.userId],
        ['hub_room', 'room'],
      ]);
      await expect(k.unlink(olivia, hub.hubId, b.orgId)).rejects.toMatchObject(
        err(ConflictError, 'link-not-active'),
      );
    });

    it('unlink is atomic: a failure in the cascade undoes everything', async () => {
      const x = await hubWithSpace('Unlink Atomic');
      await k.grantRoom(olivia, x.hub, x.spaceId, x.kit.publicKey, x.keys);
      const roles = app.get(HubRoleRepository);
      const spy = vi
        .spyOn(roles, 'removeUsersWithoutLinkedOrg')
        .mockRejectedValueOnce(new Error('boom'));
      try {
        await expect(k.unlink(olivia, x.hub.hubId, x.orgId)).rejects.toThrow(
          'boom',
        );
      } finally {
        spy.mockRestore();
      }
      expect((await linkRow(x.hub.hubId, x.orgId))?.status).toBe('approved');
      expect(await hubSpaceRows(x.hub.hubId)).toEqual([[x.spaceId, true]]);
      expect((await hubRoom(x.spaceId, x.hub.hubId)).versions).toEqual([1]);
      expect((await spaceRow(x.spaceId)).key_rotation_required).toBe(false);
    });

    it('unlink waits for a Room grant holding the link FOR SHARE; a grant waits for an unlink holding it FOR UPDATE and is then refused', async () => {
      const x = await hubWithSpace('Lock Order');
      // uma liberação em andamento (FOR SHARE no vínculo) segura o desvincular
      const share = await hold(
        `SELECT 1 FROM hub_organization WHERE hub_id = $1 AND organization_id = $2 FOR SHARE`,
        [x.hub.hubId, x.orgId],
      );
      let unlinking: Promise<void> | undefined;
      try {
        unlinking = k.unlink(olivia, x.hub.hubId, x.orgId);
        const done = settledFlag(unlinking);
        await sleep(300);
        expect(done()).toBe(false);
      } finally {
        await share.release();
        await unlinking?.catch(() => undefined);
      }
      await expect(unlinking).resolves.toBeUndefined();

      // um desvincular em andamento (FOR UPDATE) segura a liberação, que depois vê o vínculo revogado
      const y = await hubWithSpace('Lock Order 2');
      const upd = await hold(
        `SELECT 1 FROM hub_organization WHERE hub_id = $1 AND organization_id = $2 FOR UPDATE`,
        [y.hub.hubId, y.orgId],
      );
      let granting: Promise<unknown> | undefined;
      try {
        granting = k.grantRoom(
          olivia,
          y.hub,
          y.spaceId,
          y.kit.publicKey,
          y.keys,
        );
        const done = settledFlag(granting);
        await sleep(300);
        expect(done()).toBe(false);
        await upd.qr.query(
          `UPDATE hub_organization SET status = 'revoked' WHERE hub_id = $1 AND organization_id = $2`,
          [y.hub.hubId, y.orgId],
        );
        await upd.commit();
      } finally {
        await upd.release();
      }
      await expect(granting).rejects.toMatchObject(
        err(DomainValidationError, 'organization-not-linked'),
      );
      expect((await hubRoom(y.spaceId, y.hub.hubId)).roleKey).toBeNull();
    });
  });

  describe('hub existence stays hidden', () => {
    it('a non-owner admin gets the same 404 for an unknown hub id and for an existing hub without a link', async () => {
      const hub = await k.claim(olivia);
      const personal: { id: string }[] = await admin.query(
        `SELECT id FROM organizations WHERE personal_owner_user_id = $1`,
        [carl.userId],
      );
      const carlOrg = personal[0]!.id;
      for (const call of [k.approve, k.reject, k.unlink]) {
        const unknown = await call(carl, newId(), carlOrg).catch((e) => e);
        const existing = await call(carl, hub.hubId, carlOrg).catch((e) => e);
        expect(unknown).toMatchObject(err(NotFoundError, 'hub-link-not-found'));
        expect(existing).toMatchObject(
          err(NotFoundError, 'hub-link-not-found'),
        );
      }
      await k.deregister(olivia, hub.hubId);
      await expect(k.approve(carl, hub.hubId, carlOrg)).rejects.toMatchObject(
        err(NotFoundError, 'hub-link-not-found'),
      );
    });
  });

  describe('spaces on the hub', () => {
    it('the owner (a member of the space) or a Gestor of a linked org adds; strangers get 404/403; only linked, approved orgs', async () => {
      const hub = await k.claim(olivia);
      const a = await org(ana, 'HS A', [olivia, bia]);
      await k.link(olivia, hub.hubId, a.orgId);
      // espaço da Ana (Gestora), com Olivia como editora; outro só da Ana
      const shared = await space(ana, a.orgId, a.kit.publicKey, [olivia, bia]);
      const anas = await space(ana, a.orgId, a.kit.publicKey);
      await expect(
        k.addSpace(olivia, hub.hubId, shared.spaceId),
      ).resolves.toMatchObject({
        hubId: hub.hubId,
        spaceId: shared.spaceId,
        organizationId: a.orgId,
        addedByUserId: olivia.userId,
      });
      // o dono não membro do espaço: 404
      await expect(
        k.addSpace(olivia, hub.hubId, anas.spaceId),
      ).rejects.toMatchObject(err(NotFoundError, 'space-not-found'));
      // Bia vê o Hub e está no espaço, mas não é Gestora: 403
      await expect(
        k.addSpace(bia, hub.hubId, shared.spaceId),
      ).rejects.toMatchObject(DENIED);
      // Carl não vê o Hub: 404
      await expect(
        k.addSpace(carl, hub.hubId, anas.spaceId),
      ).rejects.toMatchObject(HUB_404);
      // a Gestora põe o próprio espaço
      await k.addSpace(ana, hub.hubId, anas.spaceId);

      // organização com vínculo pendente: 422
      const strict = await org(ana, 'HS Strict', [olivia]);
      await setPolicy(ana, strict.orgId, { hubLinkPolicy: 'admin_approved' });
      await k.link(olivia, hub.hubId, strict.orgId);
      const pend = await space(ana, strict.orgId, strict.kit.publicKey);
      await expect(
        k.addSpace(ana, hub.hubId, pend.spaceId),
      ).rejects.toMatchObject(
        err(DomainValidationError, 'organization-not-linked'),
      );
      expect(await hubSpaceRows(hub.hubId)).toEqual(
        [
          [shared.spaceId, true],
          [anas.spaceId, true],
        ].sort(byFirst),
      );
      expect(
        (await auditRows(a.orgId, 'hub.space.added')).map((x) => x.user_id),
      ).toEqual([olivia.userId, ana.userId]);
    });

    it('the owner removes any space and a Gestor their own; removing also revokes the Room', async () => {
      const x = await hubWithSpace('HS Remove', [bia]);
      await k.grantRoom(olivia, x.hub, x.spaceId, x.kit.publicKey, x.keys);
      // Bia é editora (não Gestora): 403; Carl: 404
      await expect(
        k.removeSpace(bia, x.hub.hubId, x.spaceId),
      ).rejects.toMatchObject(DENIED);
      await expect(
        k.removeSpace(carl, x.hub.hubId, x.spaceId),
      ).rejects.toMatchObject(HUB_404);
      await k.removeSpace(olivia, x.hub.hubId, x.spaceId);
      expect(await hubSpaceRows(x.hub.hubId)).toEqual([[x.spaceId, false]]);
      expect((await hubRoom(x.spaceId, x.hub.hubId)).roleKey).toBeNull();
      expect((await spaceRow(x.spaceId)).key_rotation_required).toBe(true);
      await expect(
        k.removeSpace(olivia, x.hub.hubId, x.spaceId),
      ).rejects.toMatchObject(err(NotFoundError, 'hub-space-not-found'));

      // Gestora (não dona) tira o próprio espaço
      const hub = await k.claim(olivia);
      const a = await org(ana, 'HS Remove 2', [olivia]);
      await k.link(olivia, hub.hubId, a.orgId);
      const anas = await space(ana, a.orgId, a.kit.publicKey);
      await k.addSpace(ana, hub.hubId, anas.spaceId);
      await k.removeSpace(ana, hub.hubId, anas.spaceId);
      expect(await hubSpaceRows(hub.hubId)).toEqual([[anas.spaceId, false]]);
    });
  });

  describe('Room', () => {
    it('the owner who is Gestor grants; the hub opens its copy; policy off gives 422; non-Gestor 403; space off the hub 422', async () => {
      const x = await hubWithSpace('Room A', [bia]);
      await expect(
        k.grantRoom(olivia, x.hub, x.spaceId, x.kit.publicKey, x.keys),
      ).resolves.toEqual({
        hubId: x.hub.hubId,
        spaceId: x.spaceId,
        roleKey: 'space_reader',
      });
      expect(
        await k.hubOpens(
          x.hub,
          (await hubWrappedKey(x.spaceId, x.hub.hubId, 1))!,
        ),
      ).toEqual(x.keys[0]);

      // Bia não é dona: 403; Carl: 404
      await expect(
        k.grantRoom(bia, x.hub, x.spaceId, x.kit.publicKey, x.keys),
      ).rejects.toMatchObject(DENIED);
      await expect(
        k.grantRoom(carl, x.hub, x.spaceId, x.kit.publicKey, x.keys),
      ).rejects.toMatchObject(HUB_404);

      // a dona, só editora de um espaço da Ana: 403 (não é Gestora)
      const hub = await k.claim(olivia);
      const a = await org(ana, 'Room B', [olivia]);
      await k.link(olivia, hub.hubId, a.orgId);
      const anas = await space(ana, a.orgId, a.kit.publicKey, [olivia]);
      await k.addSpace(ana, hub.hubId, anas.spaceId);
      await expect(
        k.grantRoom(olivia, hub, anas.spaceId, a.kit.publicKey, anas.keys),
      ).rejects.toMatchObject(DENIED);

      // espaço fora do Hub: 422
      const off = await space(olivia, x.orgId, x.kit.publicKey);
      await expect(
        k.grantRoom(olivia, x.hub, off.spaceId, x.kit.publicKey, off.keys),
      ).rejects.toMatchObject(err(DomainValidationError, 'space-not-on-hub'));

      // política desligada: liberação nova 422; a existente continua
      await k.addSpace(olivia, x.hub.hubId, off.spaceId);
      await setPolicy(olivia, x.orgId, { allowRoomSpaces: false });
      await expect(
        k.grantRoom(olivia, x.hub, off.spaceId, x.kit.publicKey, off.keys),
      ).rejects.toMatchObject(err(DomainValidationError, 'room-not-allowed'));
      expect((await hubRoom(x.spaceId, x.hub.hubId)).roleKey).toBe(
        'space_reader',
      );
    });

    it('revoke: the owner (even without being Gestor) or a Gestor; not in the Room is 404', async () => {
      const x = await hubWithSpace('Room Revoke', [bia]);
      await k.grantRoom(olivia, x.hub, x.spaceId, x.kit.publicKey, x.keys);
      await expect(
        k.revokeRoom(bia, x.hub.hubId, x.spaceId),
      ).rejects.toMatchObject(DENIED);
      await k.revokeRoom(olivia, x.hub.hubId, x.spaceId);
      expect(await hubRoom(x.spaceId, x.hub.hubId)).toMatchObject({
        roleKey: null,
        tombstoned: 1,
      });
      expect((await spaceRow(x.spaceId)).key_rotation_required).toBe(true);
      await expect(
        k.revokeRoom(olivia, x.hub.hubId, x.spaceId),
      ).rejects.toMatchObject(err(NotFoundError, 'room-not-found'));
      // o hub_space continua
      expect(await hubSpaceRows(x.hub.hubId)).toEqual([[x.spaceId, true]]);
    });
  });

  describe('hub roles', () => {
    it('assignment waits for an unlink holding the link FOR UPDATE and is then refused (no orphan role)', async () => {
      const x = await hubWithSpace('Roles Race', [bia]);
      const upd = await hold(
        `SELECT 1 FROM hub_organization WHERE hub_id = $1 AND organization_id = $2 FOR UPDATE`,
        [x.hub.hubId, x.orgId],
      );
      let assigning: Promise<unknown> | undefined;
      try {
        assigning = k.assignRole(
          olivia,
          x.hub.hubId,
          bia.userId,
          'hub_operator',
        );
        const done = settledFlag(assigning);
        await sleep(300);
        expect(done()).toBe(false);
        await upd.qr.query(
          `UPDATE hub_organization SET status = 'revoked' WHERE hub_id = $1 AND organization_id = $2`,
          [x.hub.hubId, x.orgId],
        );
        await upd.commit();
      } finally {
        await upd.release();
      }
      await expect(assigning).rejects.toMatchObject(
        err(DomainValidationError, 'user-not-in-linked-organization'),
      );
      expect(await liveHubRoles(x.hub.hubId)).not.toContainEqual([
        'hub_operator',
        bia.userId,
      ]);
    });

    it('the owner assigns hub_operator/hub_user to members of linked orgs; owner protected; role and target checked', async () => {
      const x = await hubWithSpace('Roles', [bia]);
      await expect(
        k.assignRole(olivia, x.hub.hubId, bia.userId, 'hub_operator'),
      ).resolves.toEqual({
        hubId: x.hub.hubId,
        userId: bia.userId,
        roleKey: 'hub_operator',
      });
      expect((await k.access(bia, x.hub.hubId))?.role).toBe('hub_operator');
      await expect(
        k.assignRole(olivia, x.hub.hubId, olivia.userId, 'hub_user'),
      ).rejects.toMatchObject(
        err(DomainValidationError, 'hub-owner-protected'),
      );
      await expect(
        k.assignRole(olivia, x.hub.hubId, bia.userId, 'hub_owner'),
      ).rejects.toMatchObject(err(DomainValidationError, 'role-invalid'));
      await expect(
        k.assignRole(olivia, x.hub.hubId, carl.userId, 'hub_user'),
      ).rejects.toMatchObject(
        err(DomainValidationError, 'user-not-in-linked-organization'),
      );
      await expect(
        k.assignRole(bia, x.hub.hubId, bia.userId, 'hub_user'),
      ).rejects.toMatchObject(DENIED);
      await expect(
        k.assignRole(carl, x.hub.hubId, bia.userId, 'hub_user'),
      ).rejects.toMatchObject(HUB_404);

      await k.removeRole(olivia, x.hub.hubId, bia.userId);
      expect((await k.access(bia, x.hub.hubId))?.role).toBe('hub_user');
      const personal: { id: string }[] = await admin.query(
        `SELECT id FROM organizations WHERE personal_owner_user_id = $1`,
        [olivia.userId],
      );
      expect(
        (await auditRows(personal[0]!.id, 'hub.role.changed'))
          .map((a) => a.metadata)
          .filter((m) => m['hubId'] === x.hub.hubId),
      ).toEqual([
        {
          hubId: x.hub.hubId,
          targetUserId: bia.userId,
          roleKey: 'hub_operator',
        },
        { hubId: x.hub.hubId, targetUserId: bia.userId, roleKey: null },
      ]);
    });
  });

  describe('deregister', () => {
    it('full cascade in one transaction: links, spaces, the Room in EVERY org ever linked, all hub roles, the hub; token refused', async () => {
      const hub = await k.claim(olivia);
      const a = await org(olivia, 'Dereg A', [bia]);
      const b = await org(olivia, 'Dereg B');
      await k.link(olivia, hub.hubId, a.orgId);
      await k.link(olivia, hub.hubId, b.orgId);
      const sa = await space(olivia, a.orgId, a.kit.publicKey);
      const sb = await space(olivia, b.orgId, b.kit.publicKey);
      for (const sp of [sa, sb])
        await k.addSpace(olivia, hub.hubId, sp.spaceId);
      await k.grantRoom(olivia, hub, sa.spaceId, a.kit.publicKey, sa.keys);
      await k.grantRoom(olivia, hub, sb.spaceId, b.kit.publicKey, sb.keys);
      await k.assignRole(olivia, hub.hubId, bia.userId, 'hub_user');
      // estado legado: o vínculo de B revogado por fora, com a Sala ainda lá (a lista precisa incluir B)
      await admin.query(
        `UPDATE hub_organization SET status = 'revoked' WHERE hub_id = $1 AND organization_id = $2`,
        [hub.hubId, b.orgId],
      );
      const token = await app.get(HubTokenService).issue(hub.hubId);
      await expect(
        app.get(AuthenticateHubTokenUseCase).execute(token.token),
      ).resolves.toEqual({ hubId: hub.hubId });

      // quem não é dono: 403 (vê) / 404 (não vê)
      await expect(k.deregister(bia, hub.hubId)).rejects.toMatchObject(DENIED);
      await expect(k.deregister(carl, hub.hubId)).rejects.toMatchObject(
        HUB_404,
      );

      await k.deregister(olivia, hub.hubId);
      expect(await hubDeregistered(hub.hubId)).toBe(true);
      for (const o of [a, b]) {
        expect((await linkRow(hub.hubId, o.orgId))?.deleted).toBe(true);
      }
      expect((await linkRow(hub.hubId, a.orgId))?.status).toBe('revoked');
      expect(await hubSpaceRows(hub.hubId)).toEqual(
        [
          [sa.spaceId, false],
          [sb.spaceId, false],
        ].sort(byFirst),
      );
      for (const sp of [sa, sb]) {
        expect(await hubRoom(sp.spaceId, hub.hubId)).toEqual({
          roleKey: null,
          versions: [],
          tombstoned: 1,
        });
        expect((await spaceRow(sp.spaceId)).key_rotation_required).toBe(true);
      }
      expect(await liveHubRoles(hub.hubId)).toEqual([]);
      expect(await k.access(olivia, hub.hubId)).toBeNull();
      await expect(
        app.get(AuthenticateHubTokenUseCase).execute(token.token),
      ).rejects.toMatchObject({ code: 'invalid-hub-token' });
      await expect(k.deregister(olivia, hub.hubId)).rejects.toMatchObject(
        HUB_404,
      );

      const personal: { id: string }[] = await admin.query(
        `SELECT id FROM organizations WHERE personal_owner_user_id = $1`,
        [olivia.userId],
      );
      const dereg = (
        await auditRows(personal[0]!.id, 'hub.deregistered')
      ).filter((r) => r.metadata['hubId'] === hub.hubId);
      expect(dereg).toHaveLength(1);
      expect(dereg[0]!.metadata).toMatchObject({ hubId: hub.hubId });
      expect(
        (await auditRows(a.orgId, 'hub.organization.revoked'))[0]!.metadata,
      ).toEqual({
        hubId: hub.hubId,
        reason: 'hub_deregistered',
        spaceIds: [sa.spaceId],
      });
      // B já estava revogado: só ganha a lápide, sem auditoria de revogação enganosa
      expect(await auditRows(b.orgId, 'hub.organization.revoked')).toEqual([]);
    });

    it('is atomic, and takes the hub row FOR UPDATE first (waits for a FOR SHARE holder, like a link upsert)', async () => {
      const x = await hubWithSpace('Dereg Atomic');
      await k.grantRoom(olivia, x.hub, x.spaceId, x.kit.publicKey, x.keys);
      const roles = app.get(HubRoleRepository);
      const spy = vi
        .spyOn(roles, 'removeAllOfHub')
        .mockRejectedValueOnce(new Error('boom'));
      try {
        await expect(k.deregister(olivia, x.hub.hubId)).rejects.toThrow('boom');
      } finally {
        spy.mockRestore();
      }
      expect(await hubDeregistered(x.hub.hubId)).toBe(false);
      expect(await linkRow(x.hub.hubId, x.orgId)).toMatchObject({
        status: 'approved',
        deleted: false,
      });
      expect(await hubSpaceRows(x.hub.hubId)).toEqual([[x.spaceId, true]]);
      expect((await hubRoom(x.spaceId, x.hub.hubId)).versions).toEqual([1]);
      expect(await liveHubRoles(x.hub.hubId)).toHaveLength(2);

      const share = await hold(`SELECT 1 FROM hubs WHERE id = $1 FOR SHARE`, [
        x.hub.hubId,
      ]);
      let deregistering: Promise<void> | undefined;
      try {
        deregistering = k.deregister(olivia, x.hub.hubId);
        const done = settledFlag(deregistering);
        await sleep(300);
        expect(done()).toBe(false);
        // nada mudou enquanto espera: o primeiro lock do desregistro é o do Hub
        expect(await linkRow(x.hub.hubId, x.orgId)).toMatchObject({
          deleted: false,
        });
      } finally {
        await share.release();
        await deregistering?.catch(() => undefined);
      }
      await expect(deregistering).resolves.toBeUndefined();
      expect(await hubDeregistered(x.hub.hubId)).toBe(true);
    });
  });

  describe('hooks', () => {
    it('the owner leaves a space: the Room of that space on her hubs falls, the hub_space stays; the hook only reads link rows', async () => {
      const hub = await k.claim(olivia);
      const a = await org(ana, 'Hook Space', [olivia]);
      await k.link(olivia, hub.hubId, a.orgId);
      const sp = await space(ana, a.orgId, a.kit.publicKey);
      // Olivia vira Gestora do espaço da Ana, põe no Hub e libera na Sala
      await expectStatus(
        s.addMember(
          ana.token,
          sp.spaceId,
          recipientOf(olivia),
          sp.keys,
          'space_manager',
        ),
        201,
      );
      await k.addSpace(olivia, hub.hubId, sp.spaceId);
      await k.grantRoom(olivia, hub, sp.spaceId, a.kit.publicKey, sp.keys);

      // uma transação segura o vínculo FOR UPDATE: a saída do espaço não pode esperar por ele (só lê)
      const upd = await hold(
        `SELECT 1 FROM hub_organization WHERE hub_id = $1 AND organization_id = $2 FOR UPDATE`,
        [hub.hubId, a.orgId],
      );
      try {
        await expectStatus(
          c.http().post(`/spaces/${sp.spaceId}/leave`).set(auth(olivia)),
          204,
        );
      } finally {
        await upd.release();
      }
      expect(await hubRoom(sp.spaceId, hub.hubId)).toEqual({
        roleKey: null,
        versions: [],
        tombstoned: 1,
      });
      expect(await hubSpaceRows(hub.hubId)).toEqual([[sp.spaceId, true]]);
      const revoked = await auditRows(a.orgId, 'hub.room.revoked');
      expect(revoked.map((r) => [r.user_id, r.metadata])).toEqual([
        [
          null,
          { spaceId: sp.spaceId, hubId: hub.hubId, reason: 'owner_left_space' },
        ],
      ]);
    });

    it('a person leaving an org loses hub roles only without another linked org; a failing hook undoes the exit', async () => {
      const hub = await k.claim(olivia);
      const a = await org(olivia, 'Hook Org A', [bia, carl]);
      const b = await org(olivia, 'Hook Org B', [carl]);
      await k.link(olivia, hub.hubId, a.orgId);
      await k.link(olivia, hub.hubId, b.orgId);
      await k.assignRole(olivia, hub.hubId, bia.userId, 'hub_operator');
      await k.assignRole(olivia, hub.hubId, carl.userId, 'hub_user');

      await expectStatus(
        c.http().post(`/organizations/${a.orgId}/leave`).set(auth(carl)),
        204,
      );
      // Carl segue por B
      expect((await k.access(carl, hub.hubId))?.role).toBe('hub_user');
      expect(await liveHubRoles(hub.hubId)).toContainEqual([
        'hub_user',
        carl.userId,
      ]);

      // falha do gancho desfaz a remoção da Bia
      const roles = app.get(HubRoleRepository);
      const spy = vi
        .spyOn(roles, 'removeUsersWithoutLinkedOrg')
        .mockRejectedValueOnce(new Error('boom'));
      try {
        const res = await c
          .http()
          .delete(`/organizations/${a.orgId}/members/${bia.userId}`)
          .set(auth(olivia));
        expect(res.status).toBe(500);
      } finally {
        spy.mockRestore();
      }
      expect((await k.access(bia, hub.hubId))?.role).toBe('hub_operator');

      await expectStatus(
        c
          .http()
          .delete(`/organizations/${a.orgId}/members/${bia.userId}`)
          .set(auth(olivia)),
        204,
      );
      expect(await liveHubRoles(hub.hubId)).not.toContainEqual([
        'hub_operator',
        bia.userId,
      ]);
      expect(await k.access(bia, hub.hubId)).toBeNull();
      expect(
        (await auditRows(a.orgId, 'hub.role.changed')).map((r) => [
          r.user_id,
          r.metadata,
        ]),
      ).toEqual([
        [
          olivia.userId,
          {
            hubId: hub.hubId,
            targetUserId: bia.userId,
            roleKey: null,
            reason: 'no_linked_organization',
          },
        ],
      ]);
    });

    it('the owner leaving an org revokes the links of her hubs with it, with the whole unlink cascade', async () => {
      const hub = await k.claim(olivia);
      const a = await org(ana, 'Owner Leaves', [olivia, bia]);
      await k.link(olivia, hub.hubId, a.orgId);
      const sp = await space(ana, a.orgId, a.kit.publicKey, [bia], [olivia]);
      await k.addSpace(olivia, hub.hubId, sp.spaceId);
      await k.grantRoom(olivia, hub, sp.spaceId, a.kit.publicKey, sp.keys);
      await k.assignRole(olivia, hub.hubId, bia.userId, 'hub_user');

      await expectStatus(
        c.http().post(`/organizations/${a.orgId}/leave`).set(auth(olivia)),
        204,
      );
      expect((await linkRow(hub.hubId, a.orgId))?.status).toBe('revoked');
      expect(await hubSpaceRows(hub.hubId)).toEqual([[sp.spaceId, false]]);
      expect((await hubRoom(sp.spaceId, hub.hubId)).roleKey).toBeNull();
      expect(await liveHubRoles(hub.hubId)).toEqual([
        ['hub_owner', olivia.userId],
        ['hub_room', 'room'],
      ]);
      const revoked = await auditRows(a.orgId, 'hub.organization.revoked');
      expect(revoked.map((r) => [r.user_id, r.metadata['reason']])).toEqual([
        [olivia.userId, 'owner_left_organization'],
      ]);
      // a Sala caiu na rodada de espaços do `spaces` (saída do espaço), não numa segunda rodada da cascata
      expect(revoked[0]!.metadata['roomSpaceIds']).toEqual([]);
      expect(
        (await auditRows(a.orgId, 'hub.room.revoked')).map(
          (r) => r.metadata['reason'],
        ),
      ).toEqual(['owner_left_space']);
    });

    it('owner exit waits behind a hub_space removal holding its row, then completes (hub_space before space)', async () => {
      const hub = await k.claim(olivia);
      const a = await org(ana, 'Owner Leaves Lock', [olivia]);
      await k.link(olivia, hub.hubId, a.orgId);
      const sp = await space(ana, a.orgId, a.kit.publicKey, [], [olivia]);
      await k.addSpace(olivia, hub.hubId, sp.spaceId);
      const row = await hold(
        `SELECT 1 FROM hub_space WHERE hub_id = $1 AND space_id = $2 FOR UPDATE`,
        [hub.hubId, sp.spaceId],
      );
      let leaving: Promise<unknown> | undefined;
      try {
        leaving = c
          .http()
          .post(`/organizations/${a.orgId}/leave`)
          .set(auth(olivia))
          .then((r) => r.status);
        const done = settledFlag(leaving);
        await sleep(300);
        expect(done()).toBe(false);
        // o espaço ainda não foi travado pela saída: outra transação o trava sem esperar
        const probe = await hold(
          `SELECT 1 FROM spaces WHERE id = $1 FOR UPDATE NOWAIT`,
          [sp.spaceId],
        );
        await probe.release();
      } finally {
        await row.release();
      }
      await expect(leaving).resolves.toBe(204);
      expect((await linkRow(hub.hubId, a.orgId))?.status).toBe('revoked');
    });
  });
});
