import type { INestApplication } from '@nestjs/common';
import { HubTokenService } from '../../src/identity/application/hub-token-service.js';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import { generateSpaceKey, openSpaceKey } from '../support/client-crypto.js';
import {
  conversationsKit,
  hubRecipientOf,
} from '../support/conversations-kit.js';
import { hubClient } from '../support/hub-client.js';
import { createHubIdentity, sealRoomGrants } from '../support/hub-crypto.js';
import type { ClaimedHub } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  recipientOf,
  type KeyedUser,
} from '../support/identity-client.js';

// `kind` do Hub (hub-enroll-v2): declarado na apresentação, copiado no claim, exposto na API, no sync e na
// plataforma. Sem `kind` (hub-enroll-v1) o Hub é um `appliance`.
describe('hub kind (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const h = hubClient(() => app);
  const k = conversationsKit(() => app);
  let olivia: KeyedUser;

  const kindOnSync = async (hubId: string) => {
    const token = (await app.get(HubTokenService).issue(hubId)).token;
    const page = await h.syncAll(token);
    const item = page.items.find((i) => i.type === 'hub');
    return item?.data.kind;
  };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await c.spaces.signUpKeyed('olivia@example.com', 'Olivia');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('a pc enrolls with hub-enroll-v2: GET /hubs/:id and the sync item carry kind pc', async () => {
    const hub = await h.onboard(olivia.token, 'PC da Olivia', { kind: 'pc' });
    const res = await expectStatus(
      c.http().get(`/hubs/${hub.hubId}`).set(c.bearer(olivia.token)),
      200,
    );
    expect(res.body.kind).toBe('pc');
    expect(await kindOnSync(hub.hubId)).toBe('pc');
  });

  it('a hub enrolled without kind (hub-enroll-v1) is an appliance', async () => {
    const hub = await h.onboard(olivia.token, 'Sala');
    const res = await expectStatus(
      c.http().get(`/hubs/${hub.hubId}`).set(c.bearer(olivia.token)),
      200,
    );
    expect(res.body.kind).toBe('appliance');
    expect(await kindOnSync(hub.hubId)).toBe('appliance');
  });

  it('an unknown kind is 422 validation-failed, and a v2 signature without kind is 401', async () => {
    const identity = await createHubIdentity();
    const body = await h.enrollBody(identity, { kind: 'pc' });
    const unknown = await h
      .http()
      .post('/hub-enrollments')
      .send({ ...body, kind: 'toaster' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.type).toMatch(/\/validation-failed$/);

    const { kind: _kind, ...withoutKind } = body;
    const forged = await h.http().post('/hub-enrollments').send(withoutKind);
    expect(forged.status).toBe(401);
    expect(forged.body.type).toMatch(/\/hub-signature-invalid$/);
  });

  it('a pc is never shared: a member of the linked organization gets 404 hub-not-found and no hub login; the owner sees it', async () => {
    const ana = await c.spaces.signUpKeyed('ana@example.com', 'Ana');
    const org = await c.spaces.orgWithKit(olivia, 'Agentes');
    await c.spaces.joinOrg(olivia, org.orgId, ana);
    const pc = await h.onboard(olivia.token, 'PC compartilhado', {
      kind: 'pc',
    });
    await expectStatus(
      c
        .http()
        .post(`/hubs/${pc.hubId}/organizations`)
        .set(c.bearer(olivia.token))
        .send({ organizationId: org.orgId }),
      201,
    );

    const asMember = await c
      .http()
      .get(`/hubs/${pc.hubId}`)
      .set(c.bearer(ana.token));
    expect(asMember.status).toBe(404);
    expect(asMember.body.type).toMatch(/\/hub-not-found$/);
    await expectStatus(
      c.http().get(`/hubs/${pc.hubId}`).set(c.bearer(olivia.token)),
      200,
    );

    const hubToken = await h.authenticate(pc);
    const login = await h.loginPerson(
      hubToken,
      ana.email,
      ana.account.authProof,
    );
    expect(login.status).toBe(401);
    expect(login.body.type).toMatch(/\/invalid-credentials$/);

    // the same member does see an appliance linked to the same organization
    const box = await h.onboard(olivia.token, 'Caixa');
    await expectStatus(
      c
        .http()
        .post(`/hubs/${box.hubId}/organizations`)
        .set(c.bearer(olivia.token))
        .send({ organizationId: org.orgId }),
      201,
    );
    await expectStatus(
      c.http().get(`/hubs/${box.hubId}`).set(c.bearer(ana.token)),
      200,
    );

    // GET /hubs: the member lists the appliance but not the pc; the owner lists both
    const listed = async (token: string) =>
      (
        (await expectStatus(c.http().get('/hubs').set(c.bearer(token)), 200))
          .body.items as { id: string }[]
      ).map((i) => i.id);
    const memberList = await listed(ana.token);
    expect(memberList).toContain(box.hubId);
    expect(memberList).not.toContain(pc.hubId);
    expect(await listed(olivia.token)).toEqual(
      expect.arrayContaining([pc.hubId, box.hubId]),
    );

    // GET /hub/sync: the pc knows only its owner (no other member, key blob or role); the appliance gets the member
    const people = async (hubId: string) => {
      const token = (await app.get(HubTokenService).issue(hubId)).token;
      const page = await h.syncAll(token);
      return page.items
        .filter((i) => i.type === 'member' && !i.deleted)
        .map((i) => i.data.userId);
    };
    const pcPeople = await people(pc.hubId);
    expect(pcPeople.length).toBeGreaterThan(0);
    expect(new Set(pcPeople)).toEqual(new Set([olivia.userId]));
    expect(await people(box.hubId)).toContain(ana.userId);
  });
  describe('the public key of a pc for whoever must seal copies to it', () => {
    let dora: KeyedUser; // admin, Gestora, dona do pc
    let edu: KeyedUser; // membro do espaço com o pc na Sala
    let fabio: KeyedUser; // membro da organização, fora dos espaços
    let hugo: KeyedUser; // membro de um espaço com o pc instalado, sem Sala
    let ivo: KeyedUser; // sai do espaço da Sala (troca pendente)
    let gil: KeyedUser; // de fora da organização
    let orgId: string;
    let kitPublicKey: string;
    let pc: ClaimedHub;
    let roomSpace: { spaceId: string; key: Uint8Array };
    let plainSpace: { spaceId: string; key: Uint8Array };

    const getHub = (token: string) =>
      c.http().get(`/hubs/${pc.hubId}`).set(c.bearer(token));
    const expectNotFound = async (
      res: Promise<{ status: number; body: { type?: string } }>,
    ) => {
      const r = await res;
      expect(r.status).toBe(404);
      expect(r.body.type).toMatch(/\/hub-not-found$/);
    };
    const keyView = () => ({
      id: pc.hubId,
      name: 'PC da Dora',
      kind: 'pc',
      encryptionPublicKey: pc.identity.encryptionPublicKey,
    });
    const pcSyncGrants = async () => {
      const token = (await app.get(HubTokenService).issue(pc.hubId)).token;
      return (await h.syncAll(token)).items.filter(
        (i) => i.type === 'space_key_grant' && !i.deleted,
      );
    };
    const newSpace = async (name: string, members: KeyedUser[]) => {
      const sp = await c.spaces.create(dora, orgId, kitPublicKey, name);
      await expectStatus(Promise.resolve(sp.res), 201);
      for (const u of members) {
        await expectStatus(
          c.spaces.addMember(
            dora.token,
            sp.spaceId,
            recipientOf(u),
            [sp.key],
            'space_editor',
          ),
          201,
        );
      }
      await expectStatus(
        c
          .http()
          .post(`/hubs/${pc.hubId}/spaces`)
          .set(c.bearer(dora.token))
          .send({ spaceId: sp.spaceId }),
        201,
      );
      return { spaceId: sp.spaceId, key: sp.key };
    };

    beforeAll(async () => {
      dora = await c.spaces.signUpKeyed('dora@example.com', 'Dora');
      edu = await c.spaces.signUpKeyed('edu@example.com', 'Edu');
      fabio = await c.spaces.signUpKeyed('fabio@example.com', 'Fabio');
      hugo = await c.spaces.signUpKeyed('hugo@example.com', 'Hugo');
      ivo = await c.spaces.signUpKeyed('ivo@example.com', 'Ivo');
      gil = await c.spaces.signUpKeyed('gil@example.com', 'Gil');
      const o = await c.spaces.orgWithKit(dora, 'Curadoria');
      orgId = o.orgId;
      kitPublicKey = o.kit.publicKey;
      for (const u of [edu, fabio, hugo, ivo]) {
        await c.spaces.joinOrg(dora, orgId, u);
      }
      pc = await h.onboard(dora.token, 'PC da Dora', { kind: 'pc' });
      const link = await expectStatus(
        c
          .http()
          .post(`/hubs/${pc.hubId}/organizations`)
          .set(c.bearer(dora.token))
          .send({ organizationId: orgId }),
        201,
      );
      expect(link.body.status).toBe('approved');
      roomSpace = await newSpace('Sala do PC', [edu, ivo]);
      await expectStatus(
        c
          .http()
          .put(`/hubs/${pc.hubId}/spaces/${roomSpace.spaceId}/room`)
          .set(c.bearer(dora.token))
          .send({
            recoveryPublicKey: kitPublicKey,
            grants: await sealRoomGrants(
              [roomSpace.key],
              pc.identity.encryptionPublicKey,
            ),
          }),
        200,
      );
      plainSpace = await newSpace('Sem Sala', [hugo]);
    }, 120_000);

    it('a member of a space with the pc in the Room reads only its key view; everyone else, and every other route, is 404', async () => {
      const seen = await expectStatus(getHub(edu.token), 200);
      expect(seen.body).toEqual(keyView());

      // the org member outside the spaces, the member of a space with the pc installed but no Room, an outsider
      await expectNotFound(getHub(fabio.token));
      await expectNotFound(getHub(hugo.token));
      await expectNotFound(getHub(gil.token));

      // nothing else of the pc opens for the space member
      await expectNotFound(
        c.http().get(`/hubs/${pc.hubId}/spaces`).set(c.bearer(edu.token)),
      );
      await expectNotFound(
        c
          .http()
          .patch(`/hubs/${pc.hubId}`)
          .set(c.bearer(edu.token))
          .send({ name: 'Meu' }),
      );
      expect(
        (
          (
            await expectStatus(
              c.http().get('/hubs').set(c.bearer(edu.token)),
              200,
            )
          ).body.items as { id: string }[]
        ).map((i) => i.id),
      ).not.toContain(pc.hubId);

      // the owner still gets the full view
      const own = await expectStatus(getHub(dora.token), 200);
      expect(own.body.role).toBe('hub_owner');
    });

    it('the space member completes a pending rotation with hubGrants for the pc, and the pc opens its copy', async () => {
      await expectStatus(
        c
          .http()
          .delete(`/spaces/${roomSpace.spaceId}/members/${ivo.userId}`)
          .set(c.bearer(dora.token)),
        204,
      );
      const recipients = await c.spaces.memberRecipients(
        edu.token,
        roomSpace.spaceId,
      );
      const hubs = await c.spaces.roomHubRecipients(
        edu.token,
        roomSpace.spaceId,
      );
      expect(hubs).toEqual([
        { hubId: pc.hubId, publicKey: pc.identity.encryptionPublicKey },
      ]);
      const v2 = await generateSpaceKey();
      await expectStatus(
        c.spaces.rotate(edu.token, roomSpace.spaceId, {
          version: 2,
          key: v2,
          recipients,
          kitPublicKey,
        }),
        201,
      );

      const grants = await pcSyncGrants();
      const v2Copy = grants.find(
        (g) =>
          g.data.hubId === pc.hubId &&
          g.data.spaceId === roomSpace.spaceId &&
          g.data.version === 2,
      );
      expect(v2Copy).toBeDefined();
      expect(
        await openSpaceKey(
          v2Copy!.data.wrappedKey as string,
          pc.identity.encryptionPublicKey,
          pc.identity.encryptionPrivateKey,
        ),
      ).toEqual(v2);
    });

    it("the pc sync carries only its owner's copies and its own, never another member's", async () => {
      const grants = await pcSyncGrants();
      const users = new Set(
        grants.filter((g) => g.data.userId).map((g) => g.data.userId),
      );
      expect(users).toEqual(new Set([dora.userId]));
      const hubCopies = grants.filter((g) => g.data.hubId);
      expect(hubCopies.length).toBeGreaterThan(0);
      expect(hubCopies.every((g) => g.data.hubId === pc.hubId)).toBe(true);
      expect(
        grants.every((g) => Boolean(g.data.userId) !== Boolean(g.data.hubId)),
      ).toBe(true);
    });

    it('a participant of a conversation the pc executes reads its key view', async () => {
      const conv = await k.create(dora, plainSpace.spaceId, {
        executor: hubRecipientOf(pc),
      });
      await expectStatus(Promise.resolve(conv.res), 201);
      // a member of that space who is not a participant yet: still 404
      await expectNotFound(getHub(hugo.token));
      await expectStatus(
        k.share(
          dora,
          plainSpace.spaceId,
          conv.id,
          [recipientOf(hugo)],
          conv.keys,
        ),
        200,
      );
      const seen = await expectStatus(getHub(hugo.token), 200);
      expect(seen.body).toEqual(keyView());
    });
  });
});
