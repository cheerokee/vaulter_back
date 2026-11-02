import type { INestApplication } from '@nestjs/common';
import type request from 'supertest';
import type { DataSource } from 'typeorm';
import { HUB_LABELS } from '../../src/hubs/domain/hub-signed-message.js';
import { HubRoleRepository } from '../../src/hubs/domain/hub-role.repository.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { generateSpaceKey } from '../support/client-crypto.js';
import { hubClient, type SyncItem } from '../support/hub-client.js';
import {
  createHubIdentity,
  sealRoomGrants,
  signHubMessage,
} from '../support/hub-crypto.js';
import {
  type ClaimedHub,
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
import { hubRoom, spaceRow } from '../support/spaces-db.js';

/** Asserts a problem+json error with a stable `type` and returns the body without the per-request id. */
function expectProblem(
  res: request.Response,
  status: number,
  type: string,
): Record<string, unknown> {
  if (res.status !== status) {
    throw new Error(
      `expected ${status} ${type}, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.type).toMatch(new RegExp(`/${type}$`));
  const { requestId: _r, ...rest } = res.body as Record<string, unknown>;
  return rest;
}

const UNKNOWN_ID = '0190f3c0-0000-7000-8000-000000000000';

// As rotas de Hub da spec §7 pela HTTP real (guards, pipes, filtro problem+json), papel de runtime (RLS valendo) e a
// cripto real do Hub (identidade Ed25519/X25519 no "aparelho") e do cliente (cópias trancadas). Cobre o fluxo da
// spec §4 de ponta a ponta e os itens 1–5 do Review Focus do plano.
describe('hubs over HTTP (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const k = hubsKit(() => app);
  const as = (u: KeyedUser) => c.bearer(u.token);

  let olivia: KeyedUser; // dona dos Hubs
  let ana: KeyedUser; // membro das organizações da Olivia
  let carl: KeyedUser; // estranho
  let dan: KeyedUser; // admin de uma organização com `admin_approved`

  const onboard = (owner: KeyedUser, name = 'Sala') =>
    h.onboard(owner.token, name);
  const org = async (
    creator: KeyedUser,
    name: string,
    members: KeyedUser[],
  ) => {
    const o = await s.orgWithKit(creator, name);
    for (const u of members) await s.joinOrg(creator, o.orgId, u);
    return o;
  };
  /** PUT room like the owner's app: reads the hub's encryption key from the API and seals every version for it. */
  const grantRoom = async (
    owner: KeyedUser,
    hubId: string,
    spaceId: string,
    kitPublicKey: string,
    keys: Uint8Array[],
  ) => {
    const hubKey = (
      await expectStatus(c.http().get(`/hubs/${hubId}`).set(as(owner)), 200)
    ).body.encryptionPublicKey as string;
    return c
      .http()
      .put(`/hubs/${hubId}/spaces/${spaceId}/room`)
      .set(as(owner))
      .send({
        recoveryPublicKey: kitPublicKey,
        grants: await sealRoomGrants(keys, hubKey),
      });
  };
  /**
   * A hub of Olivia, linked to a new organization (Olivia admin, Ana member), with one space of Olivia (Gestor; Ana
   * added with `anaRole`) on the hub and open in its Room. All over HTTP.
   */
  const hubWithRoom = async (name: string, anaRole = 'space_editor') => {
    const o = await org(olivia, name, [ana]);
    const hub = await onboard(olivia, name);
    await expectStatus(
      c
        .http()
        .post(`/hubs/${hub.hubId}/organizations`)
        .set(as(olivia))
        .send({ organizationId: o.orgId }),
      201,
    );
    const sp = await s.create(olivia, o.orgId, o.kit.publicKey, `S-${name}`);
    expect(sp.res.status).toBe(201);
    await expectStatus(
      s.addMember(
        olivia.token,
        sp.spaceId,
        recipientOf(ana),
        [sp.key],
        anaRole,
      ),
      201,
    );
    await expectStatus(
      c
        .http()
        .post(`/hubs/${hub.hubId}/spaces`)
        .set(as(olivia))
        .send({ spaceId: sp.spaceId }),
      201,
    );
    await expectStatus(
      grantRoom(olivia, hub.hubId, sp.spaceId, o.kit.publicKey, [sp.key]),
      200,
    );
    return { ...o, hub, spaceId: sp.spaceId, key: sp.key };
  };
  const itemsOf = (items: SyncItem[], type: string) =>
    items.filter((i) => i.type === type);
  const hubCopies = (items: SyncItem[], hubId: string) =>
    itemsOf(items, 'space_key_grant').filter(
      (i) => !i.deleted && i.data.hubId === hubId,
    );

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = await adminDataSource();
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    carl = await s.signUpKeyed('carl@example.com', 'Carl');
    dan = await s.signUpKeyed('dan@example.com', 'Dan');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('device flow (spec §4)', () => {
    it('enroll -> pending -> claim -> claimed -> challenge -> token -> link -> space -> Room -> sync; the hub opens its copy', async () => {
      // 1–2. primeiro boot e apresentação
      const identity = await createHubIdentity();
      const enroll = await expectStatus(h.enroll(identity), 201);
      expect(Object.keys(enroll.body).sort()).toEqual([
        'claimCode',
        'enrollmentId',
        'expiresAt',
      ]);
      expect(enroll.body.claimCode).toMatch(/^[0-9]{8}$/);
      const expiresIn = Date.parse(enroll.body.expiresAt) - Date.now();
      expect(expiresIn).toBeGreaterThan(9 * 60_000);
      expect(expiresIn).toBeLessThanOrEqual(10 * 60_000);
      const enrollmentId = enroll.body.enrollmentId as string;
      // o código só existe como hash no banco
      const stored = await admin.query(
        `SELECT claim_code_hash FROM hub_enrollments WHERE id = $1`,
        [enrollmentId],
      );
      expect(JSON.stringify(stored)).not.toContain(enroll.body.claimCode);

      // 4. o Hub consulta o status: pendente
      expect(
        (await expectStatus(h.status(identity, enrollmentId), 200)).body,
      ).toEqual({ status: 'pending' });

      // 3. o dono reivindica pelo app
      const claim = await expectStatus(
        c
          .http()
          .post('/hubs/claim')
          .set(as(olivia))
          .send({ claimCode: enroll.body.claimCode, name: ' Sala ' }),
        201,
      );
      expect(claim.body).toEqual({
        id: expect.any(String),
        name: 'Sala',
        ownerUserId: olivia.userId,
        encryptionPublicKey: identity.encryptionPublicKey,
        lastSeenAt: null,
        createdAt: expect.any(String),
      });
      const hubId = claim.body.id as string;

      // 4. reivindicado: o status traz o hubId
      expect(
        (await expectStatus(h.status(identity, enrollmentId), 200)).body,
      ).toEqual({ status: 'claimed', hubId });
      const hub: ClaimedHub = { hubId, identity };

      // 5. desafio e token de Hub
      const ch = await expectStatus(h.challenge(hubId), 200);
      expect(ch.body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Date.parse(ch.body.expiresAt) - Date.now()).toBeLessThanOrEqual(
        60_000,
      );
      const tok = await expectStatus(
        h.token(identity, hubId, ch.body.challenge),
        200,
      );
      expect(Object.keys(tok.body).sort()).toEqual([
        'accessToken',
        'expiresAt',
      ]);
      const accessToken = tok.body.accessToken as string;
      const header = JSON.parse(
        Buffer.from(accessToken.split('.')[0]!, 'base64url').toString(),
      );
      expect(header).toMatchObject({ alg: 'EdDSA', typ: 'hub+jwt' });

      // o dono vê o Hub (lastSeenAt preenchido pela autenticação)
      const mine = await expectStatus(
        c.http().get('/hubs').set(as(olivia)),
        200,
      );
      expect(mine.body).toEqual({
        items: [
          expect.objectContaining({
            id: hubId,
            role: 'hub_owner',
            lastSeenAt: expect.any(String),
          }),
        ],
        nextCursor: null,
      });

      // 6. vincula uma segunda organização (a pessoal já veio aprovada na reivindicação)
      const o = await org(olivia, 'Flow Org', [ana]);
      const link = await expectStatus(
        c
          .http()
          .post(`/hubs/${hubId}/organizations`)
          .set(as(olivia))
          .send({ organizationId: o.orgId }),
        201,
      );
      expect(link.body).toMatchObject({
        hubId,
        organizationId: o.orgId,
        status: 'approved',
        requestedByUserId: olivia.userId,
      });
      const links = await expectStatus(
        c.http().get(`/hubs/${hubId}/organizations`).set(as(olivia)),
        200,
      );
      expect(links.body.items).toHaveLength(2);
      expect(
        (links.body.items as { status: string }[]).every(
          (l) => l.status === 'approved',
        ),
      ).toBe(true);

      // 7. põe um espaço no Hub
      const sp = await s.create(olivia, o.orgId, o.kit.publicKey, 'Manuais');
      expect(sp.res.status).toBe(201);
      const added = await expectStatus(
        c
          .http()
          .post(`/hubs/${hubId}/spaces`)
          .set(as(olivia))
          .send({ spaceId: sp.spaceId }),
        201,
      );
      expect(added.body).toEqual({
        hubId,
        spaceId: sp.spaceId,
        organizationId: o.orgId,
        addedByUserId: olivia.userId,
      });
      expect(
        (
          await expectStatus(
            c.http().get(`/hubs/${hubId}/spaces`).set(as(olivia)),
            200,
          )
        ).body.items,
      ).toEqual([added.body]);

      // 8. libera na Sala: cópias trancadas para a chave de cifra do Hub
      const room = await expectStatus(
        grantRoom(olivia, hubId, sp.spaceId, o.kit.publicKey, [sp.key]),
        200,
      );
      expect(room.body).toEqual({
        hubId,
        spaceId: sp.spaceId,
        roleKey: 'space_reader',
      });

      // 9. sincroniza e abre a própria cópia com a chave privada do aparelho
      const { items } = await h.syncAll(accessToken);
      expect(itemsOf(items, 'hub')[0]?.data).toMatchObject({
        id: hubId,
        name: 'Sala',
      });
      expect(
        itemsOf(items, 'hub_organization')
          .filter((i) => !i.deleted)
          .map((i) => i.data.organizationId),
      ).toContain(o.orgId);
      expect(itemsOf(items, 'space').map((i) => i.data.id)).toEqual([
        sp.spaceId,
      ]);
      const copies = hubCopies(items, hubId);
      expect(copies).toHaveLength(1);
      expect(copies[0]!.data.version).toBe(1);
      expect(
        await k.hubOpens(hub, copies[0]!.data.wrappedKey as string),
      ).toEqual(sp.key);
      // e a Ana, membro da organização, aparece com o material trancado (sem authHash)
      const anaItem = itemsOf(items, 'member').find(
        (i) => i.data.userId === ana.userId,
      );
      expect(anaItem?.data).toMatchObject({
        publicKey: ana.account.publicKey,
        roles: { hub: 'hub_user' },
      });
      expect(JSON.stringify(items)).not.toContain('authHash');

      // o dono renomeia
      const renamed = await expectStatus(
        c
          .http()
          .patch(`/hubs/${hubId}`)
          .set(as(olivia))
          .send({ name: 'Sala de reunião' }),
        200,
      );
      expect(renamed.body).toMatchObject({
        id: hubId,
        name: 'Sala de reunião',
        role: 'hub_owner',
      });
    }, 60_000);
  });

  describe('key rotation with the Room (Review Focus 3)', () => {
    it('passes only with the hub copy; after unlink the hub never gets the new version', async () => {
      const x = await hubWithRoom('Rotate');
      const token = await h.authenticate(x.hub);
      const people = [recipientOf(olivia), recipientOf(ana)];
      const hubRecipient = {
        hubId: x.hub.hubId,
        publicKey: x.hub.identity.encryptionPublicKey,
      };
      const v2 = await generateSpaceKey();
      const missing = await expectStatus(
        s.rotate(olivia.token, x.spaceId, {
          version: 2,
          key: v2,
          recipients: people,
          kitPublicKey: x.kit.publicKey,
          hubs: [],
        }),
        409,
      );
      expect(
        expectProblem(missing, 409, 'key-rotation-mismatch'),
      ).toMatchObject({
        expectedHubIds: [x.hub.hubId],
        missingHubIds: [x.hub.hubId],
        unexpectedHubIds: [],
      });
      await expectStatus(
        s.rotate(olivia.token, x.spaceId, {
          version: 2,
          key: v2,
          recipients: people,
          kitPublicKey: x.kit.publicKey,
          hubs: [hubRecipient],
        }),
        201,
      );
      let { items, since } = await h.syncAll(token);
      const v2Copy = hubCopies(items, x.hub.hubId).find(
        (i) => i.data.version === 2,
      );
      expect(
        await k.hubOpens(x.hub, v2Copy!.data.wrappedKey as string),
      ).toEqual(v2);

      // desvincular: a Sala cai, a troca fica pendente e o Hub não entra mais na troca
      await c
        .http()
        .delete(`/hubs/${x.hub.hubId}/organizations/${x.orgId}`)
        .set(as(olivia))
        .expect(204);
      expect((await spaceRow(x.spaceId)).key_rotation_required).toBe(true);
      const v3 = await generateSpaceKey();
      const stale = await expectStatus(
        s.rotate(ana.token, x.spaceId, {
          version: 3,
          key: v3,
          recipients: people,
          kitPublicKey: x.kit.publicKey,
          hubs: [hubRecipient],
        }),
        409,
      );
      expectProblem(stale, 409, 'key-rotation-mismatch');
      await expectStatus(
        s.rotate(ana.token, x.spaceId, {
          version: 3,
          key: v3,
          recipients: people,
          kitPublicKey: x.kit.publicKey,
        }),
        201,
      );
      expect((await hubRoom(x.spaceId, x.hub.hubId)).versions).toEqual([]);

      // incremental: só a lápide do vínculo (e o que saiu da Sala), nunca a versão 3
      const delta = (await h.syncAll(token, since)).items;
      expect(
        itemsOf(delta, 'hub_organization').find(
          (i) => i.data.organizationId === x.orgId,
        ),
      ).toEqual(
        expect.objectContaining({
          deleted: true,
          data: { hubId: x.hub.hubId, organizationId: x.orgId },
        }),
      );
      // completa: nada da organização desvinculada além da lápide do vínculo
      ({ items, since } = await h.syncAll(token));
      for (const i of [...delta, ...items]) {
        if (i.type === 'space_key_grant' || i.type === 'space_key') {
          expect(i.data.version).not.toBe(3);
        }
      }
      expect(
        items.filter(
          (i) =>
            (i.data.organizationId === x.orgId || i.data.id === x.orgId) &&
            i.type !== 'hub_organization',
        ),
      ).toEqual([]);
      expect(since).toBeGreaterThan(0);
    }, 60_000);

    it('a member who does not own the hub finds the Room hubs through the API and rotates; the 409s say what is wrong', async () => {
      // Ana is a Gestor of the space (so she may rotate before a rotation is pending), never the hub owner
      const x = await hubWithRoom('Rotate Discover', 'space_manager');
      const token = await h.authenticate(x.hub);
      // Ana (not the hub owner) sees the Room in the space details...
      const details = await expectStatus(
        c.http().get(`/spaces/${x.spaceId}`).set(as(ana)),
        200,
      );
      expect(details.body.roomHubs).toEqual([
        { hubId: x.hub.hubId, roleKey: 'space_reader' },
      ]);
      // ...and reads the hub's encryption key (member of the linked org), never its signing key
      const hub = await expectStatus(
        c.http().get(`/hubs/${x.hub.hubId}`).set(as(ana)),
        200,
      );
      expect(hub.body).toMatchObject({
        encryptionPublicKey: x.hub.identity.encryptionPublicKey,
        role: 'hub_user',
      });
      expect(JSON.stringify(hub.body)).not.toContain(
        x.hub.identity.signingPublicKey,
      );
      expect(await s.roomHubRecipients(ana.token, x.spaceId)).toEqual([
        {
          hubId: x.hub.hubId,
          publicKey: x.hub.identity.encryptionPublicKey,
        },
      ]);

      // a stale set and a missing member: the problem lists the ids to fix
      const v2 = await generateSpaceKey();
      const stranger = newId();
      const wrongHubs = expectProblem(
        await s.rotate(ana.token, x.spaceId, {
          version: 2,
          key: v2,
          recipients: [recipientOf(olivia), recipientOf(ana)],
          kitPublicKey: x.kit.publicKey,
          hubs: [
            {
              hubId: stranger,
              publicKey: x.hub.identity.encryptionPublicKey,
            },
          ],
        }),
        409,
        'key-rotation-mismatch',
      );
      expect(wrongHubs).toMatchObject({
        expectedHubIds: [x.hub.hubId],
        missingHubIds: [x.hub.hubId],
        unexpectedHubIds: [stranger],
        duplicatedHubIds: [],
      });
      const wrongPeople = expectProblem(
        await s.rotate(ana.token, x.spaceId, {
          version: 2,
          key: v2,
          recipients: [recipientOf(ana)],
          kitPublicKey: x.kit.publicKey,
        }),
        409,
        'key-rotation-mismatch',
      );
      expect(wrongPeople).toMatchObject({
        missingUserIds: [olivia.userId],
        unexpectedUserIds: [],
      });
      expect(wrongPeople.expectedUserIds).toEqual(
        [olivia.userId, ana.userId].sort(),
      );
      expect(
        expectProblem(
          await s.rotate(ana.token, x.spaceId, {
            version: 3,
            key: v2,
            recipients: [recipientOf(olivia), recipientOf(ana)],
            kitPublicKey: x.kit.publicKey,
          }),
          409,
          'key-rotation-mismatch',
        ),
      ).toMatchObject({ expectedVersion: 2 });

      // the owner takes the space out of the Room: rotation is pending, and Ana rotates with the discovered set
      await c
        .http()
        .delete(`/hubs/${x.hub.hubId}/spaces/${x.spaceId}/room`)
        .set(as(olivia))
        .expect(204);
      expect(
        (
          await expectStatus(
            c.http().get(`/spaces/${x.spaceId}`).set(as(ana)),
            200,
          )
        ).body,
      ).toMatchObject({ keyRotationRequired: true, roomHubs: [] });
      // back in the Room, so the discovered set is not empty
      await expectStatus(
        grantRoom(olivia, x.hub.hubId, x.spaceId, x.kit.publicKey, [x.key]),
        200,
      );
      await expectStatus(
        s.rotate(ana.token, x.spaceId, {
          version: 2,
          key: v2,
          recipients: await s.memberRecipients(ana.token, x.spaceId),
          kitPublicKey: x.kit.publicKey,
        }),
        201,
      );
      const after = await expectStatus(
        c.http().get(`/spaces/${x.spaceId}`).set(as(ana)),
        200,
      );
      expect(after.body).toMatchObject({
        currentKeyVersion: 2,
        keyRotationRequired: false,
      });
      const v2Copy = hubCopies(
        (await h.syncAll(token)).items,
        x.hub.hubId,
      ).find((i) => i.data.version === 2);
      expect(
        await k.hubOpens(x.hub, v2Copy!.data.wrappedKey as string),
      ).toEqual(v2);
    }, 60_000);

    it('a deregistered hub leaves the Room: rotation passes without it and refuses a copy for it', async () => {
      const x = await hubWithRoom('Rotate Dereg');
      await c.http().delete(`/hubs/${x.hub.hubId}`).set(as(olivia)).expect(204);
      const people = [recipientOf(olivia), recipientOf(ana)];
      const v2 = await generateSpaceKey();
      const withHub = await expectStatus(
        s.rotate(olivia.token, x.spaceId, {
          version: 2,
          key: v2,
          recipients: people,
          kitPublicKey: x.kit.publicKey,
          hubs: [
            {
              hubId: x.hub.hubId,
              publicKey: x.hub.identity.encryptionPublicKey,
            },
          ],
        }),
        409,
      );
      expectProblem(withHub, 409, 'key-rotation-mismatch');
      await expectStatus(
        s.rotate(olivia.token, x.spaceId, {
          version: 2,
          key: v2,
          recipients: people,
          kitPublicKey: x.kit.publicKey,
        }),
        201,
      );
      expect((await hubRoom(x.spaceId, x.hub.hubId)).versions).toEqual([]);
    }, 60_000);
  });

  describe('link request by link code (two consents)', () => {
    it('a member asks with the code the hub shows; the org admin and the owner both consent', async () => {
      const hub = await onboard(olivia, 'Request');
      const token = await h.authenticate(hub);
      const orgB = await org(dan, 'Request Org', [ana]);
      await expectStatus(
        c
          .http()
          .patch(`/organizations/${orgB.orgId}`)
          .set(as(dan))
          .send({ hubLinkPolicy: 'admin_approved' }),
        200,
      );
      const code = await expectStatus(h.linkCode(token), 201);
      expect(Object.keys(code.body).sort()).toEqual(['expiresAt', 'linkCode']);
      expect(code.body.linkCode).toMatch(/^[0-9]{8}$/);
      const stored = await admin.query(
        `SELECT code_hash FROM hub_link_codes WHERE hub_id = $1`,
        [hub.hubId],
      );
      expect(JSON.stringify(stored)).not.toContain(code.body.linkCode);

      // a Ana (membro, nem dona nem admin) pede: o pedido não revela o Hub
      const req = await expectStatus(
        c
          .http()
          .post('/hubs/link-requests')
          .set(as(ana))
          .send({ linkCode: code.body.linkCode, organizationId: orgB.orgId }),
        201,
      );
      expect(req.body).toEqual({
        organizationId: orgB.orgId,
        status: 'pending',
      });
      // uso único
      expectProblem(
        await c
          .http()
          .post('/hubs/link-requests')
          .set(as(ana))
          .send({ linkCode: code.body.linkCode, organizationId: orgB.orgId }),
        422,
        'link-code-invalid',
      );

      // o admin vê o pedido e aprova: falta o dono
      const asAdmin = await expectStatus(
        c.http().get(`/hubs/${hub.hubId}/organizations`).set(as(dan)),
        200,
      );
      expect(asAdmin.body.items).toEqual([
        expect.objectContaining({
          organizationId: orgB.orgId,
          status: 'pending',
          requestedByUserId: ana.userId,
        }),
      ]);
      const byAdmin = await expectStatus(
        c
          .http()
          .post(`/hubs/${hub.hubId}/organizations/${orgB.orgId}/approve`)
          .set(as(dan)),
        200,
      );
      expect(byAdmin.body).toMatchObject({
        status: 'pending',
        orgApprovedAt: expect.any(String),
        ownerApprovedAt: null,
      });
      // antes do vínculo ativo, nada da organização chega ao Hub
      const before = (await h.syncAll(token)).items;
      expect(
        before.filter(
          (i) => i.type === 'organization' && i.data.id === orgB.orgId,
        ),
      ).toEqual([]);

      // o dono aprova: vínculo ativo, a organização chega na sincronização
      const byOwner = await expectStatus(
        c
          .http()
          .post(`/hubs/${hub.hubId}/organizations/${orgB.orgId}/approve`)
          .set(as(olivia)),
        200,
      );
      expect(byOwner.body).toMatchObject({
        status: 'approved',
        ownerApprovedAt: expect.any(String),
      });
      expect(await linkRow(hub.hubId, orgB.orgId)).toMatchObject({
        status: 'approved',
        owner_approved_by_user_id: olivia.userId,
        org_approved_by_user_id: dan.userId,
      });
      const after = (await h.syncAll(token)).items;
      expect(
        after.filter(
          (i) => i.type === 'organization' && i.data.id === orgB.orgId,
        ),
      ).toHaveLength(1);
      // e agora a Ana enxerga o Hub (membro de organização vinculada), como hub_user
      expect(
        (
          await expectStatus(
            c.http().get(`/hubs/${hub.hubId}`).set(as(ana)),
            200,
          )
        ).body.role,
      ).toBe('hub_user');
    }, 60_000);

    it('an admin under admin_approved finds the pending request in GET /organizations/:orgId/hub-links and approves it with only the returned hubId', async () => {
      const orgB = await org(dan, 'Discover Org', [ana]);
      await expectStatus(
        c
          .http()
          .patch(`/organizations/${orgB.orgId}`)
          .set(as(dan))
          .send({ hubLinkPolicy: 'admin_approved' }),
        200,
      );
      // two hubs of Olivia; Ana asks for both with the codes they show
      const hubs = [
        await onboard(olivia, 'Discover A'),
        await onboard(olivia, 'Discover B'),
      ];
      for (const hub of hubs) {
        const code = (
          await expectStatus(h.linkCode(await h.authenticate(hub)), 201)
        ).body.linkCode as string;
        await expectStatus(
          c
            .http()
            .post('/hubs/link-requests')
            .set(as(ana))
            .send({ linkCode: code, organizationId: orgB.orgId }),
          201,
        );
      }
      // the owner consents from her own hub list (she knows her hubs)
      for (const hub of hubs) {
        await expectStatus(
          c
            .http()
            .post(`/hubs/${hub.hubId}/organizations/${orgB.orgId}/approve`)
            .set(as(olivia)),
          200,
        );
      }

      // Dan does not see the hubs yet...
      for (const hub of hubs) {
        expectProblem(
          await c.http().get(`/hubs/${hub.hubId}`).set(as(dan)),
          404,
          'hub-not-found',
        );
      }
      // ...but lists the organization's pending requests, one page at a time, by hub id
      const url = `/organizations/${orgB.orgId}/hub-links`;
      const first = await expectStatus(
        c.http().get(`${url}?status=pending&limit=1`).set(as(dan)),
        200,
      );
      const second = await expectStatus(
        c
          .http()
          .get(
            `${url}?status=pending&limit=1&cursor=${first.body.nextCursor as string}`,
          )
          .set(as(dan)),
        200,
      );
      expect(second.body.nextCursor).toBeNull();
      const listed = [...first.body.items, ...second.body.items] as Record<
        string,
        unknown
      >[];
      const sorted = [...hubs].sort((a, b) => (a.hubId < b.hubId ? -1 : 1));
      expect(listed.map((i) => i.hubId)).toEqual(sorted.map((x) => x.hubId));
      expect(Object.keys(listed[0]!).sort()).toEqual([
        'createdAt',
        'hubId',
        'hubName',
        'orgApprovedAt',
        'organizationId',
        'ownerApprovedAt',
        'requestedByUserId',
        'status',
      ]);
      const target = listed.find((i) => i.hubName === 'Discover A')!;
      expect(target).toEqual({
        hubId: hubs[0]!.hubId,
        hubName: 'Discover A',
        organizationId: orgB.orgId,
        status: 'pending',
        requestedByUserId: ana.userId,
        ownerApprovedAt: expect.any(String),
        orgApprovedAt: null,
        createdAt: expect.any(String),
      });

      // the second consent with nothing but the listed hubId
      const approved = await expectStatus(
        c
          .http()
          .post(
            `/hubs/${target.hubId as string}/organizations/${orgB.orgId}/approve`,
          )
          .set(as(dan)),
        200,
      );
      expect(approved.body).toMatchObject({
        hubId: hubs[0]!.hubId,
        status: 'approved',
      });
      // the filter follows the status
      const pending = await expectStatus(
        c.http().get(`${url}?status=pending`).set(as(dan)),
        200,
      );
      expect(pending.body.items.map((i: { hubId: string }) => i.hubId)).toEqual(
        [hubs[1]!.hubId],
      );
      const approvedList = await expectStatus(
        c.http().get(`${url}?status=approved`).set(as(dan)),
        200,
      );
      expect(approvedList.body.items).toEqual([
        expect.objectContaining({
          hubId: hubs[0]!.hubId,
          hubName: 'Discover A',
          status: 'approved',
          orgApprovedAt: expect.any(String),
        }),
      ]);
      const all = await expectStatus(c.http().get(url).set(as(dan)), 200);
      expect(all.body.items).toHaveLength(2);

      // who may list: a member without org.hubs.approve 403, a stranger 404 (same as an unknown org)
      expectProblem(
        await c.http().get(url).set(as(ana)),
        403,
        'permission-denied',
      );
      const stranger = expectProblem(
        await c.http().get(url).set(as(carl)),
        404,
        'organization-not-found',
      );
      expect(
        expectProblem(
          await c
            .http()
            .get(`/organizations/${UNKNOWN_ID}/hub-links`)
            .set(as(carl)),
          404,
          'organization-not-found',
        ),
      ).toEqual(stranger);
      expectProblem(
        await c.http().get('/organizations/nope/hub-links').set(as(dan)),
        422,
        'validation-failed',
      );
      expectProblem(
        await c.http().get(`${url}?status=bogus`).set(as(dan)),
        422,
        'validation-failed',
      );
      expectProblem(
        await c.http().get(`${url}?cursor=bad!`).set(as(dan)),
        422,
        'invalid-cursor',
      );
    }, 60_000);

    it('reject: the owner refuses a pending request', async () => {
      const hub = await onboard(olivia, 'Reject');
      const token = await h.authenticate(hub);
      const o = await org(dan, 'Reject Org', [ana]);
      const code = (await expectStatus(h.linkCode(token), 201)).body.linkCode;
      await expectStatus(
        c
          .http()
          .post('/hubs/link-requests')
          .set(as(ana))
          .send({ linkCode: code, organizationId: o.orgId }),
        201,
      );
      const res = await expectStatus(
        c
          .http()
          .post(`/hubs/${hub.hubId}/organizations/${o.orgId}/reject`)
          .set(as(olivia)),
        200,
      );
      expect(res.body.status).toBe('rejected');
      expectProblem(
        await c
          .http()
          .post(`/hubs/${hub.hubId}/organizations/${o.orgId}/approve`)
          .set(as(olivia)),
        409,
        'link-not-pending',
      );
    }, 60_000);
  });

  describe('Review Focus 1: no fake hub', () => {
    it('a reused challenge, a signature under another label or by another key are refused with one 401', async () => {
      const hub = await onboard(olivia, 'Fake');
      const ch = (await expectStatus(h.challenge(hub.hubId), 200)).body
        .challenge as string;
      const bodies: Record<string, unknown>[] = [];
      // rótulo errado (mesmos campos, outro rótulo)
      const wrongLabel = await signHubMessage(hub.identity, HUB_LABELS.status, {
        hubId: hub.hubId,
        challenge: ch,
      });
      bodies.push(
        expectProblem(
          await h.token(hub.identity, hub.hubId, ch, wrongLabel),
          401,
          'hub-auth-failed',
        ),
      );
      // outra chave
      const thief = await createHubIdentity();
      bodies.push(
        expectProblem(
          await h.token(thief, hub.hubId, ch),
          401,
          'hub-auth-failed',
        ),
      );
      // uma tentativa ruim não queima o desafio legítimo
      await expectStatus(h.token(hub.identity, hub.hubId, ch), 200);
      // desafio reusado
      bodies.push(
        expectProblem(
          await h.token(hub.identity, hub.hubId, ch),
          401,
          'hub-auth-failed',
        ),
      );
      // desafio que nunca existiu
      bodies.push(
        expectProblem(
          await h.token(
            hub.identity,
            hub.hubId,
            Buffer.alloc(32, 7).toString('base64url'),
          ),
          401,
          'hub-auth-failed',
        ),
      );
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      // formato inválido para no DTO (sem chegar ao caso de uso)
      expectProblem(
        await c
          .http()
          .post('/hub-auth/token')
          .send({ hubId: hub.hubId, challenge: 'x', signature: 'y' }),
        422,
        'validation-failed',
      );
    }, 60_000);

    it('enrollment and status signatures: another label or key is refused; status failures are one 404', async () => {
      const identity = await createHubIdentity();
      const nonce = Buffer.alloc(16, 1).toString('base64url');
      const timestamp = new Date().toISOString();
      const wrongLabel = await signHubMessage(identity, HUB_LABELS.auth, {
        signingPublicKey: identity.signingPublicKey,
        encryptionPublicKey: identity.encryptionPublicKey,
        nonce,
        timestamp,
      });
      expectProblem(
        await h.enroll(identity, { nonce, timestamp, signature: wrongLabel }),
        401,
        'hub-signature-invalid',
      );
      expectProblem(
        await h.enroll(identity, {
          timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
        }),
        422,
        'timestamp-out-of-window',
      );

      const device = await h.enrolled();
      const thief = await createHubIdentity();
      const now = new Date().toISOString();
      const failures = [
        // assinado por outra chave
        await h.status(thief, device.enrollmentId),
        // rótulo errado
        await h.status(device.identity, device.enrollmentId, {
          timestamp: now,
          signature: await signHubMessage(device.identity, HUB_LABELS.auth, {
            enrollmentId: device.enrollmentId,
            timestamp: now,
          }),
        }),
        // apresentação inexistente, com assinatura válida
        await h.status(device.identity, UNKNOWN_ID),
        // id malformado
        await h.status(device.identity, 'not-a-uuid'),
        // sem assinatura
        await c
          .http()
          .get(`/hub-enrollments/${device.enrollmentId}/status`)
          .set('X-Hub-Timestamp', now),
        // assinatura que não é base64url
        await h.status(device.identity, device.enrollmentId, {
          signature: '!'.repeat(86),
        }),
      ];
      const bodies = failures.map((res) =>
        expectProblem(res, 404, 'enrollment-not-found'),
      );
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      // o timestamp (independe da apresentação) dá 422
      expectProblem(
        await h.status(device.identity, device.enrollmentId, {
          timestamp: new Date(Date.now() + 10 * 60_000).toISOString(),
        }),
        422,
        'timestamp-out-of-window',
      );
      expectProblem(
        await c
          .http()
          .get(`/hub-enrollments/${device.enrollmentId}/status`)
          .set('X-Hub-Signature', 'x'),
        422,
        'timestamp-invalid',
      );
    }, 60_000);

    it('a deregistered hub: its token stops working and a new challenge never validates', async () => {
      const hub = await onboard(olivia, 'Dereg Auth');
      const token = await h.authenticate(hub);
      await expectStatus(h.sync(token), 200);
      await c.http().delete(`/hubs/${hub.hubId}`).set(as(olivia)).expect(204);
      expectProblem(await h.sync(token), 401, 'invalid-hub-token');
      expectProblem(await h.linkCode(token), 401, 'invalid-hub-token');
      // o desafio é um chamariz indistinguível...
      const ch = await expectStatus(h.challenge(hub.hubId), 200);
      expect(ch.body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // ...que nunca vira token, nem com a chave certa
      expectProblem(
        await h.token(hub.identity, hub.hubId, ch.body.challenge),
        401,
        'hub-auth-failed',
      );
      // e o dono não o vê mais
      expectProblem(
        await c.http().get(`/hubs/${hub.hubId}`).set(as(olivia)),
        404,
        'hub-not-found',
      );
    }, 60_000);

    it('a hub token is refused on user routes and a user token on hub routes', async () => {
      const hub = await onboard(olivia, 'Typ');
      const hubToken = await h.authenticate(hub);
      for (const path of ['/me', '/hubs', `/hubs/${hub.hubId}`]) {
        expectProblem(
          await c.http().get(path).set(c.bearer(hubToken)),
          401,
          'invalid-access-token',
        );
      }
      expectProblem(
        await c
          .http()
          .post('/hubs/claim')
          .set(c.bearer(hubToken))
          .send({ claimCode: '12345678', name: 'x' }),
        401,
        'invalid-access-token',
      );
      expectProblem(await h.sync(olivia.token), 401, 'invalid-hub-token');
      expectProblem(await h.linkCode(olivia.token), 401, 'invalid-hub-token');
      expectProblem(await c.http().get('/hub/sync'), 401, 'invalid-hub-token');
    }, 60_000);

    it('who may see and act: 404 for a hub one cannot see (same as an unknown id), 403 for one without permission', async () => {
      const x = await hubWithRoom('Matrix');
      const hidden = expectProblem(
        await c.http().get(`/hubs/${x.hub.hubId}`).set(as(carl)),
        404,
        'hub-not-found',
      );
      expect(
        expectProblem(
          await c.http().get(`/hubs/${UNKNOWN_ID}`).set(as(carl)),
          404,
          'hub-not-found',
        ),
      ).toEqual(hidden);
      for (const res of [
        await c
          .http()
          .patch(`/hubs/${x.hub.hubId}`)
          .set(as(carl))
          .send({ name: 'x' }),
        await c.http().delete(`/hubs/${x.hub.hubId}`).set(as(carl)),
        await c.http().get(`/hubs/${x.hub.hubId}/spaces`).set(as(carl)),
        await c
          .http()
          .put(`/hubs/${x.hub.hubId}/roles/${ana.userId}`)
          .set(as(carl))
          .send({ roleKey: 'hub_operator' }),
      ]) {
        expectProblem(res, 404, 'hub-not-found');
      }
      // a Ana vê o Hub (organização vinculada), mas não é dona
      expect(
        (
          await expectStatus(
            c.http().get(`/hubs/${x.hub.hubId}`).set(as(ana)),
            200,
          )
        ).body.role,
      ).toBe('hub_user');
      for (const res of [
        await c
          .http()
          .patch(`/hubs/${x.hub.hubId}`)
          .set(as(ana))
          .send({ name: 'x' }),
        await c.http().delete(`/hubs/${x.hub.hubId}`).set(as(ana)),
        await c
          .http()
          .put(`/hubs/${x.hub.hubId}/roles/${ana.userId}`)
          .set(as(ana))
          .send({ roleKey: 'hub_operator' }),
      ]) {
        expectProblem(res, 403, 'permission-denied');
      }
      // ids malformados param no pipe
      expectProblem(
        await c.http().get('/hubs/not-a-uuid').set(as(olivia)),
        422,
        'validation-failed',
      );
      expectProblem(
        await c
          .http()
          .delete(`/hubs/${x.hub.hubId}/spaces/not-a-uuid/room`)
          .set(as(olivia)),
        422,
        'validation-failed',
      );
    }, 60_000);

    it('roles: the owner assigns and removes hub_operator; removing is 204 whether or not there is a role', async () => {
      const x = await hubWithRoom('Roles');
      const put = await expectStatus(
        c
          .http()
          .put(`/hubs/${x.hub.hubId}/roles/${ana.userId}`)
          .set(as(olivia))
          .send({ roleKey: 'hub_operator' }),
        200,
      );
      expect(put.body).toEqual({
        hubId: x.hub.hubId,
        userId: ana.userId,
        roleKey: 'hub_operator',
      });
      expect(
        (
          await expectStatus(
            c.http().get(`/hubs/${x.hub.hubId}`).set(as(ana)),
            200,
          )
        ).body.role,
      ).toBe('hub_operator');
      expectProblem(
        await c
          .http()
          .put(`/hubs/${x.hub.hubId}/roles/${ana.userId}`)
          .set(as(olivia))
          .send({ roleKey: 'hub_owner' }),
        422,
        'role-invalid',
      );
      expectProblem(
        await c
          .http()
          .put(`/hubs/${x.hub.hubId}/roles/${carl.userId}`)
          .set(as(olivia))
          .send({ roleKey: 'hub_user' }),
        422,
        'user-not-in-linked-organization',
      );
      for (let i = 0; i < 2; i++) {
        await c
          .http()
          .delete(`/hubs/${x.hub.hubId}/roles/${ana.userId}`)
          .set(as(olivia))
          .expect(204);
      }
      expectProblem(
        await c
          .http()
          .delete(`/hubs/${x.hub.hubId}/roles/${olivia.userId}`)
          .set(as(olivia)),
        422,
        'hub-owner-protected',
      );
    }, 60_000);
  });

  describe('Review Focus 2: data outside an approved link never syncs', () => {
    it('a pending link brings only a keys-only tombstone; unlink makes the link a tombstone and stops the data', async () => {
      const x = await hubWithRoom('Scope');
      const token = await h.authenticate(x.hub);
      // organização com pedido pendente (política admin_approved, o dono pede)
      const pending = await org(dan, 'Scope Pending', [olivia]);
      await expectStatus(
        c
          .http()
          .patch(`/organizations/${pending.orgId}`)
          .set(as(dan))
          .send({ hubLinkPolicy: 'admin_approved' }),
        200,
      );
      const link = await expectStatus(
        c
          .http()
          .post(`/hubs/${x.hub.hubId}/organizations`)
          .set(as(olivia))
          .send({ organizationId: pending.orgId }),
        201,
      );
      expect(link.body.status).toBe('pending');
      const { items, since } = await h.syncAll(token);
      const ofPending = items.filter((i) =>
        JSON.stringify(i.data).includes(pending.orgId),
      );
      expect(ofPending).toEqual([
        expect.objectContaining({
          type: 'hub_organization',
          deleted: true,
          data: { hubId: x.hub.hubId, organizationId: pending.orgId },
        }),
      ]);
      expect(JSON.stringify(items)).not.toContain(dan.userId);
      // o Hub também não aprova nada: rotas de usuário recusam o token dele
      expectProblem(
        await c
          .http()
          .post(`/hubs/${x.hub.hubId}/organizations/${pending.orgId}/approve`)
          .set(c.bearer(token)),
        401,
        'invalid-access-token',
      );

      // desvincular a organização da Sala
      await c
        .http()
        .delete(`/hubs/${x.hub.hubId}/organizations/${x.orgId}`)
        .set(as(olivia))
        .expect(204);
      const delta = (await h.syncAll(token, since)).items;
      expect(
        delta.filter(
          (i) =>
            i.type === 'hub_organization' && i.data.organizationId === x.orgId,
        ),
      ).toEqual([
        expect.objectContaining({
          deleted: true,
          data: { hubId: x.hub.hubId, organizationId: x.orgId },
        }),
      ]);
      const full = (await h.syncAll(token)).items;
      expect(
        full.filter((i) => JSON.stringify(i.data).includes(x.orgId)),
      ).toEqual([
        expect.objectContaining({ type: 'hub_organization', deleted: true }),
      ]);
      expect(hubCopies(full, x.hub.hubId)).toEqual([]);
    }, 60_000);
  });

  describe('Review Focus 4: codes', () => {
    it('claim code: wrong, used or expired give the same error; nothing tells whether a hub exists', async () => {
      const claim = (u: KeyedUser, claimCode: string) =>
        c.http().post('/hubs/claim').set(as(u)).send({ claimCode, name: 'X' });
      const device = await h.enrolled();
      const wrong = device.claimCode === '00000000' ? '00000001' : '00000000';
      const bodies = [
        expectProblem(await claim(carl, wrong), 422, 'claim-code-invalid'),
      ];
      await expectStatus(claim(carl, device.claimCode), 201);
      bodies.push(
        expectProblem(
          await claim(dan, device.claimCode),
          422,
          'claim-code-invalid',
        ),
      );
      const late = await h.enrolled();
      await admin.query(
        `UPDATE hub_enrollments SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [late.enrollmentId],
      );
      bodies.push(
        expectProblem(
          await claim(dan, late.claimCode),
          422,
          'claim-code-invalid',
        ),
      );
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      // formato errado para no DTO, sem tocar no código
      expectProblem(await claim(dan, '1234'), 422, 'validation-failed');
      // o desafio de um Hub inexistente tem a mesma forma do de um Hub real
      const real = await expectStatus(
        h.challenge((await h.waitClaimed(device)).hubId),
        200,
      );
      const ghost = await expectStatus(h.challenge(UNKNOWN_ID), 200);
      expect(Object.keys(ghost.body).sort()).toEqual(
        Object.keys(real.body).sort(),
      );
      expect(ghost.body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }, 60_000);

    it('link code: single use, wrong and deregistered-hub codes are the same 422, and membership is checked first', async () => {
      const hub = await onboard(olivia, 'Codes');
      const token = await h.authenticate(hub);
      const o = await org(dan, 'Codes Org', [ana]);
      const request = (
        u: KeyedUser,
        linkCode: string,
        organizationId = o.orgId,
      ) =>
        c
          .http()
          .post('/hubs/link-requests')
          .set(as(u))
          .send({ linkCode, organizationId });
      const code = (await expectStatus(h.linkCode(token), 201)).body
        .linkCode as string;
      // quem não é membro da organização: 404 antes de consumir o código
      expectProblem(await request(carl, code), 404, 'organization-not-found');
      const wrong = code === '00000000' ? '00000001' : '00000000';
      const bodies = [
        expectProblem(await request(ana, wrong), 422, 'link-code-invalid'),
      ];
      await expectStatus(request(ana, code), 201);
      bodies.push(
        expectProblem(await request(ana, code), 422, 'link-code-invalid'),
      );
      // código de um Hub que foi desregistrado
      const other = await onboard(olivia, 'Codes 2');
      const otherCode = (
        await expectStatus(h.linkCode(await h.authenticate(other)), 201)
      ).body.linkCode as string;
      await c.http().delete(`/hubs/${other.hubId}`).set(as(olivia)).expect(204);
      bodies.push(
        expectProblem(await request(ana, otherCode), 422, 'link-code-invalid'),
      );
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expectProblem(await request(ana, 'abcdefgh'), 422, 'validation-failed');
    }, 60_000);
  });

  describe('Review Focus 5: cascades over HTTP', () => {
    it('deregister is atomic (a failure answers 500 and changes nothing), then tombstones everything', async () => {
      const x = await hubWithRoom('Cascade Dereg');
      const token = await h.authenticate(x.hub);
      const roles = app.get(HubRoleRepository);
      const spy = vi
        .spyOn(roles, 'removeAllOfHub')
        .mockRejectedValueOnce(new Error('boom'));
      try {
        const res = await c
          .http()
          .delete(`/hubs/${x.hub.hubId}`)
          .set(as(olivia));
        const body = expectProblem(res, 500, 'internal-error');
        expect(JSON.stringify(body)).not.toContain('boom');
      } finally {
        spy.mockRestore();
      }
      expect(await hubDeregistered(x.hub.hubId)).toBe(false);
      expect((await linkRow(x.hub.hubId, x.orgId))?.status).toBe('approved');
      expect(await hubSpaceRows(x.hub.hubId)).toEqual([[x.spaceId, true]]);
      expect((await hubRoom(x.spaceId, x.hub.hubId)).versions).toEqual([1]);
      await expectStatus(h.sync(token), 200);

      await c.http().delete(`/hubs/${x.hub.hubId}`).set(as(olivia)).expect(204);
      expect(await hubDeregistered(x.hub.hubId)).toBe(true);
      expect(await linkRow(x.hub.hubId, x.orgId)).toMatchObject({
        deleted: true,
      });
      expect(await hubSpaceRows(x.hub.hubId)).toEqual([[x.spaceId, false]]);
      expect((await hubRoom(x.spaceId, x.hub.hubId)).versions).toEqual([]);
      expect(await liveHubRoles(x.hub.hubId)).toEqual([]);
      expect((await spaceRow(x.spaceId)).key_rotation_required).toBe(true);
      expectProblem(await h.sync(token), 401, 'invalid-hub-token');
    }, 60_000);

    it('unlink is atomic over HTTP too', async () => {
      const x = await hubWithRoom('Cascade Unlink');
      const roles = app.get(HubRoleRepository);
      const spy = vi
        .spyOn(roles, 'removeUsersWithoutLinkedOrg')
        .mockRejectedValueOnce(new Error('boom'));
      try {
        expectProblem(
          await c
            .http()
            .delete(`/hubs/${x.hub.hubId}/organizations/${x.orgId}`)
            .set(as(olivia)),
          500,
          'internal-error',
        );
      } finally {
        spy.mockRestore();
      }
      expect((await linkRow(x.hub.hubId, x.orgId))?.status).toBe('approved');
      expect(await hubSpaceRows(x.hub.hubId)).toEqual([[x.spaceId, true]]);
      expect((await hubRoom(x.spaceId, x.hub.hubId)).versions).toEqual([1]);
      expect((await spaceRow(x.spaceId)).key_rotation_required).toBe(false);
    }, 60_000);

    it('removing the space from the hub and revoking the Room over HTTP', async () => {
      const x = await hubWithRoom('Cascade Space');
      await c
        .http()
        .delete(`/hubs/${x.hub.hubId}/spaces/${x.spaceId}/room`)
        .set(as(olivia))
        .expect(204);
      expect((await hubRoom(x.spaceId, x.hub.hubId)).versions).toEqual([]);
      expect((await spaceRow(x.spaceId)).key_rotation_required).toBe(true);
      expectProblem(
        await c
          .http()
          .delete(`/hubs/${x.hub.hubId}/spaces/${x.spaceId}/room`)
          .set(as(olivia)),
        404,
        'room-not-found',
      );
      await c
        .http()
        .delete(`/hubs/${x.hub.hubId}/spaces/${x.spaceId}`)
        .set(as(olivia))
        .expect(204);
      expect(await hubSpaceRows(x.hub.hubId)).toEqual([[x.spaceId, false]]);
      expectProblem(
        await grantRoom(olivia, x.hub.hubId, x.spaceId, x.kit.publicKey, [
          x.key,
        ]),
        422,
        'space-not-on-hub',
      );
    }, 60_000);

    it('the owner leaving the space drops the Room (hub_space stays); a member leaving the org loses her hub role', async () => {
      // a Ana fica Gestora: o espaço não pode ficar sem Gestor quando a Olivia sai
      const x = await hubWithRoom('Cascade Exit', 'space_manager');
      await expectStatus(
        c
          .http()
          .put(`/hubs/${x.hub.hubId}/roles/${ana.userId}`)
          .set(as(olivia))
          .send({ roleKey: 'hub_operator' }),
        200,
      );
      await c
        .http()
        .post(`/spaces/${x.spaceId}/leave`)
        .set(as(olivia))
        .expect(204);
      expect((await hubRoom(x.spaceId, x.hub.hubId)).versions).toEqual([]);
      expect(await hubSpaceRows(x.hub.hubId)).toEqual([[x.spaceId, true]]);
      expect((await spaceRow(x.spaceId)).key_rotation_required).toBe(true);

      expect(await liveHubRoles(x.hub.hubId)).toContainEqual([
        'hub_operator',
        ana.userId,
      ]);
      await c
        .http()
        .post(`/organizations/${x.orgId}/leave`)
        .set(as(ana))
        .expect(204);
      expect(await liveHubRoles(x.hub.hubId)).not.toContainEqual([
        'hub_operator',
        ana.userId,
      ]);
      expectProblem(
        await c.http().get(`/hubs/${x.hub.hubId}`).set(as(ana)),
        404,
        'hub-not-found',
      );
    }, 60_000);
  });

  describe('hub lists are cursor-paginated', () => {
    it('links and spaces page by cursor, for the owner and for a linked member across organizations', async () => {
      const hub = await onboard(olivia, 'Pages');
      const orgs = [
        await org(olivia, 'Pages 1', [ana]),
        await org(olivia, 'Pages 2', [ana]),
      ];
      const spaceIds: string[] = [];
      for (const o of orgs) {
        await expectStatus(
          c
            .http()
            .post(`/hubs/${hub.hubId}/organizations`)
            .set(as(olivia))
            .send({ organizationId: o.orgId }),
          201,
        );
      }
      for (const o of [orgs[0]!, orgs[1]!, orgs[1]!]) {
        const sp = await s.create(
          olivia,
          o.orgId,
          o.kit.publicKey,
          `P-${spaceIds.length}`,
        );
        expect(sp.res.status).toBe(201);
        await expectStatus(
          s.addMember(olivia.token, sp.spaceId, recipientOf(ana), [sp.key]),
          201,
        );
        await expectStatus(
          c
            .http()
            .post(`/hubs/${hub.hubId}/spaces`)
            .set(as(olivia))
            .send({ spaceId: sp.spaceId }),
          201,
        );
        spaceIds.push(sp.spaceId);
      }
      /** Follows nextCursor with limit=1; every page has one item and the cursor ends as null. */
      const pages = async (u: KeyedUser, path: string, key: string) => {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 10; i++) {
          const res = await expectStatus(
            c
              .http()
              .get(path)
              .query(cursor ? { limit: 1, cursor } : { limit: 1 })
              .set(as(u)),
            200,
          );
          const body = res.body as {
            items: Record<string, string>[];
            nextCursor: string | null;
          };
          seen.push(...body.items.map((x) => x[key]!));
          if (!body.nextCursor) return seen;
          expect(body.items).toHaveLength(1);
          cursor = body.nextCursor;
        }
        throw new Error('too many pages');
      };
      // dono: a organização pessoal e as duas vinculadas, em ordem de id
      const links = await pages(
        olivia,
        `/hubs/${hub.hubId}/organizations`,
        'organizationId',
      );
      expect(links).toHaveLength(3);
      expect(links).toEqual([...links].sort());
      expect(links).toEqual(expect.arrayContaining(orgs.map((o) => o.orgId)));
      // dono e Ana (membro das duas organizações): os três espaços, em ordem de id, cruzando as organizações
      const sorted = [...spaceIds].sort();
      expect(
        await pages(olivia, `/hubs/${hub.hubId}/spaces`, 'spaceId'),
      ).toEqual(sorted);
      expect(await pages(ana, `/hubs/${hub.hubId}/spaces`, 'spaceId')).toEqual(
        sorted,
      );
      // cursor inválido
      expectProblem(
        await c
          .http()
          .get(`/hubs/${hub.hubId}/spaces`)
          .query({ cursor: 'nope' })
          .set(as(olivia)),
        422,
        'invalid-cursor',
      );
      expectProblem(
        await c
          .http()
          .get(`/hubs/${hub.hubId}/organizations`)
          .query({ limit: 101 })
          .set(as(olivia)),
        422,
        'validation-failed',
      );
    }, 60_000);
  });

  describe('races over HTTP (single use under concurrency)', () => {
    it('one claim code, one challenge and one link code each have exactly one winner', async () => {
      const statuses = (rs: request.Response[]) =>
        rs.map((r) => r.status).sort((a, b) => a - b);
      const device = await h.enrolled();
      const claims = await Promise.all(
        [olivia, carl, dan].map((u) =>
          c
            .http()
            .post('/hubs/claim')
            .set(as(u))
            .send({ claimCode: device.claimCode, name: 'Race' }),
        ),
      );
      expect(statuses(claims)).toEqual([201, 422, 422]);
      const owner = [olivia, carl, dan][
        claims.findIndex((r) => r.status === 201)
      ]!;
      const hub = await h.waitClaimed(device);

      const ch = (await expectStatus(h.challenge(hub.hubId), 200)).body
        .challenge as string;
      const tokens = await Promise.all(
        [0, 1, 2].map(() => h.token(hub.identity, hub.hubId, ch)),
      );
      expect(statuses(tokens)).toEqual([200, 401, 401]);

      const token = tokens.find((r) => r.status === 200)!.body
        .accessToken as string;
      const code = (await expectStatus(h.linkCode(token), 201)).body
        .linkCode as string;
      const o = await org(owner, `Race Org ${owner.email}`, [ana]);
      const requests = await Promise.all(
        [0, 1, 2].map(() =>
          c
            .http()
            .post('/hubs/link-requests')
            .set(as(ana))
            .send({ linkCode: code, organizationId: o.orgId }),
        ),
      );
      expect(statuses(requests)).toEqual([201, 422, 422]);
    }, 60_000);
  });

  it('an unknown id in a path, with a well-formed UUID, is a 404 for every hub route a stranger calls', async () => {
    const id = newId();
    for (const res of [
      await c.http().get(`/hubs/${id}/organizations`).set(as(carl)),
      await c
        .http()
        .post(`/hubs/${id}/organizations`)
        .set(as(carl))
        .send({ organizationId: newId() }),
      await c
        .http()
        .post(`/hubs/${id}/spaces`)
        .set(as(carl))
        .send({ spaceId: newId() }),
    ]) {
      expect(res.status).toBe(404);
    }
  }, 60_000);
});
