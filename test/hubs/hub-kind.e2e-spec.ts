import type { INestApplication } from '@nestjs/common';
import { HubTokenService } from '../../src/identity/application/hub-token-service.js';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import { hubClient } from '../support/hub-client.js';
import { createHubIdentity } from '../support/hub-crypto.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
} from '../support/identity-client.js';

// `kind` do Hub (hub-enroll-v2): declarado na apresentação, copiado no claim, exposto na API, no sync e na
// plataforma. Sem `kind` (hub-enroll-v1) o Hub é um `appliance`.
describe('hub kind (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const h = hubClient(() => app);
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
});
