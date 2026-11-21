import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import { agentsKit } from '../support/agents-kit.js';
import { hubClient } from '../support/hub-client.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
} from '../support/identity-client.js';

describe('agent tool catalog (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const h = hubClient(() => app);
  const agents = agentsKit(() => app);
  let olivia: KeyedUser;

  const listOfHub = async (token: string, hubId: string) =>
    (
      await expectStatus(
        c.http().get(`/hubs/${hubId}/agent/tools`).set(c.bearer(token)),
        200,
      )
    ).body.items as { name: string }[];

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await c.spaces.signUpKeyed('olivia@example.com', 'Olivia');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('PUT /hub/agent/tools replaces the whole list', async () => {
    const pc = await h.onboard(olivia.token, 'PC da Olivia', { kind: 'pc' });
    const three = agents.defaultTools();
    expect((await agents.publishTools(pc, three)).status).toBe(204);
    expect(
      (await listOfHub(olivia.token, pc.hubId)).map((t) => t.name).sort(),
    ).toEqual(three.map((t) => t.name).sort());

    const only = [three[1]!];
    expect((await agents.publishTools(pc, only)).status).toBe(204);
    const after = (await expectStatus(
      c.http().get(`/hubs/${pc.hubId}/agent/tools`).set(c.bearer(olivia.token)),
      200,
    )) as { body: { items: Record<string, unknown>[] } };
    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0]).toMatchObject({
      name: 'browser:open',
      title: 'Open page',
      category: 'browser',
    });

    // a name that comes back is revived, with the new content
    const back = [{ ...three[0]!, title: 'Create issue (v2)' }, three[1]!];
    expect((await agents.publishTools(pc, back)).status).toBe(204);
    const revived = await listOfHub(olivia.token, pc.hubId);
    expect(revived.map((t) => t.name).sort()).toEqual(
      back.map((t) => t.name).sort(),
    );

    // an empty list clears the catalog
    expect((await agents.publishTools(pc, [])).status).toBe(204);
    expect(await listOfHub(olivia.token, pc.hubId)).toEqual([]);
  });

  it('an invalid catalog is 422 validation-failed and keeps the previous list', async () => {
    const pc = await h.onboard(olivia.token, 'PC invalido', { kind: 'pc' });
    await agents.publishTools(pc, agents.defaultTools());
    const bad = await agents.publishTools(pc, [
      agents.defaultTools()[0]!,
      { ...agents.defaultTools()[2]!, inputSchema: {} },
    ]);
    expect(bad.status).toBe(422);
    expect(bad.body.type).toMatch(/\/validation-failed$/);
    expect(bad.body.index).toBe(1);
    expect(await listOfHub(olivia.token, pc.hubId)).toHaveLength(3);
  });

  it('an appliance hub gets the not-found of an unknown route', async () => {
    const box = await h.onboard(olivia.token, 'Caixa');
    const res = await agents.publishTools(box);
    expect(res.status).toBe(404);
    expect(res.body.detail).toBe('Cannot PUT /hub/agent/tools');

    const boxToken = await h.authenticate(box);
    const unknown = await c
      .http()
      .put('/hub/agent/nothing')
      .set('Authorization', `Bearer ${boxToken}`)
      .send({});
    expect(unknown.status).toBe(404);
    expect({
      ...res.body,
      detail: undefined,
      instance: undefined,
      requestId: undefined,
    }).toEqual({
      ...unknown.body,
      detail: undefined,
      requestId: undefined,
      instance: undefined,
    });

    // no token: still the hub token error, never the 404
    const anonymous = await c
      .http()
      .put('/hub/agent/tools')
      .send({ tools: [] });
    expect(anonymous.status).toBe(401);
  });

  it('GET /hubs/:id/agent/tools is owner only', async () => {
    const ana = await c.spaces.signUpKeyed('ana@example.com', 'Ana');
    const org = await c.spaces.orgWithKit(olivia, 'Agentes');
    await c.spaces.joinOrg(olivia, org.orgId, ana);
    const pc = await h.onboard(olivia.token, 'PC do dono', { kind: 'pc' });
    await expectStatus(
      c
        .http()
        .post(`/hubs/${pc.hubId}/organizations`)
        .set(c.bearer(olivia.token))
        .send({ organizationId: org.orgId }),
      201,
    );
    await agents.publishTools(pc);

    const other = await c
      .http()
      .get(`/hubs/${pc.hubId}/agent/tools`)
      .set(c.bearer(ana.token));
    expect(other.status).toBe(404);
    expect(other.body.type).toMatch(/\/hub-not-found$/);
    expect(await listOfHub(olivia.token, pc.hubId)).toHaveLength(3);

    // an appliance has no catalog, not even for its owner
    const box = await h.onboard(olivia.token, 'Caixa 2');
    const own = await c
      .http()
      .get(`/hubs/${box.hubId}/agent/tools`)
      .set(c.bearer(olivia.token));
    expect(own.status).toBe(404);
    expect(own.body.type).toMatch(/\/hub-not-found$/);
  });

  it('GET /organizations/:orgId/agent/tools lists names and titles of linked agents without hubId', async () => {
    const admin = await c.spaces.signUpKeyed('admin@example.com', 'Admin');
    const bia = await c.spaces.signUpKeyed('bia@example.com', 'Bia');
    const caio = await c.spaces.signUpKeyed('caio@example.com', 'Caio');
    const outsider = await c.spaces.signUpKeyed('out@example.com', 'Fora');
    const org = await c.spaces.orgWithKit(admin, 'Lista');
    await c.spaces.joinOrg(admin, org.orgId, bia);
    await c.spaces.joinOrg(admin, org.orgId, caio);

    const linked = async (user: KeyedUser, name: string, link: boolean) => {
      const pc = await h.onboard(user.token, name, { kind: 'pc' });
      if (link) {
        await expectStatus(
          c
            .http()
            .post(`/hubs/${pc.hubId}/organizations`)
            .set(c.bearer(user.token))
            .send({ organizationId: org.orgId }),
          201,
        );
      }
      return pc;
    };
    const [t1, t2, t3] = agents.defaultTools();
    const pcBia = await linked(bia, 'PC Bia', true);
    const pcCaio = await linked(caio, 'PC Caio', true);
    const unlinked = await linked(caio, 'PC solto', false);
    await agents.publishTools(pcBia, [t1!, t2!]);
    await agents.publishTools(pcCaio, [t2!, t3!]);
    await agents.publishTools(unlinked, [
      { ...t1!, name: 'mcp:secret/only_here', title: 'Not linked' },
    ]);

    const res = await expectStatus(
      c
        .http()
        .get(`/organizations/${org.orgId}/agent/tools`)
        .set(c.bearer(admin.token)),
      200,
    );
    expect(res.body.items).toEqual([
      { name: 'browser:open', title: 'Open page' },
      { name: 'folder:read', title: 'Read file' },
      { name: 'mcp:github/create_issue', title: 'Create issue' },
    ]);
    const raw = JSON.stringify(res.body);
    for (const hub of [pcBia, pcCaio, unlinked]) {
      expect(raw).not.toContain(hub.hubId);
    }

    const asMember = await c
      .http()
      .get(`/organizations/${org.orgId}/agent/tools`)
      .set(c.bearer(bia.token));
    expect(asMember.status).toBe(403);
    const asOutsider = await c
      .http()
      .get(`/organizations/${org.orgId}/agent/tools`)
      .set(c.bearer(outsider.token));
    expect(asOutsider.status).toBe(404);
  });
});
