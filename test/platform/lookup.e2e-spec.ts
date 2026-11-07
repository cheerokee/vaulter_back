import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
} from '../support/client-crypto.js';
import { hubsKit } from '../support/hubs-kit.js';
import { identityClient } from '../support/identity-client.js';
import { keysDeep } from '../support/json-keys.js';
import { grantRoleInDb, platformClient } from '../support/platform-kit.js';

const PASSWORD = 'correct horse battery staple';
const MISSING_ID = '0190f3c0-0000-7000-8000-000000000000';
const FORBIDDEN_KEY = /key|wrapped|encrypted|publicKey/i;

describe('Platform lookups and audit listing (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  const c = identityClient(() => app);
  const p = platformClient(() => app);
  const hk = hubsKit(() => app);
  const get = (token: string, url: string) =>
    request(app.getHttpServer())
      .get(url)
      .set({ Authorization: `Bearer ${token}` });

  type User = { userId: string; token: string; email: string };
  let admin: User;
  let support: User;
  let support2: User;
  let finance: User;
  let owner: User;
  let proof: string;

  beforeAll(async () => {
    app = await createTestApp();
    account = await createClientAccount(PASSWORD);
    proof = account.authProof;
  }, 60_000);
  beforeEach(async () => {
    await resetDatabase();
    admin = await c.signUp(account, 'admin@example.com', 'Admin');
    support = await c.signUp(account, 'support@example.com', 'Sup');
    support2 = await c.signUp(account, 'support2@example.com', 'Sup2');
    finance = await c.signUp(account, 'finance@example.com', 'Fin');
    owner = await c.signUp(account, 'owner@example.com', 'Owner');
    await grantRoleInDb(admin.userId, 'platform_admin');
    await grantRoleInDb(support.userId, 'platform_support');
    await grantRoleInDb(support2.userId, 'platform_support');
    await grantRoleInDb(finance.userId, 'platform_finance');
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  it('support finds an account by e-mail (any case) without keys', async () => {
    const res = await get(
      support.token,
      '/platform/lookup/users?email=OWNER@Example.com',
    ).expect(200);
    expect(res.body).toEqual({
      userId: owner.userId,
      name: 'Owner',
      email: 'owner@example.com',
    });
    await get(
      support.token,
      '/platform/lookup/users?email=nobody@example.com',
    ).expect(404);
    await get(support.token, '/platform/lookup/users').expect(422);
  });

  it('support finds a hub and an organization, no key-like fields', async () => {
    const hub = await hk.claim(owner);
    const org = await c.createOrg(owner.token, 'Acme').expect(201);
    const h = await get(
      support.token,
      `/platform/lookup/hubs/${hub.hubId}`,
    ).expect(200);
    expect(h.body).toMatchObject({
      hubId: hub.hubId,
      ownerUserId: owner.userId,
    });
    const o = await get(
      support.token,
      `/platform/lookup/organizations/${org.body.id}`,
    ).expect(200);
    expect(o.body).toMatchObject({ organizationId: org.body.id, name: 'Acme' });
    for (const body of [h.body, o.body]) {
      expect(keysDeep(body).filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
    }
    await get(support.token, `/platform/lookup/hubs/${MISSING_ID}`).expect(404);
    await get(
      support.token,
      `/platform/lookup/organizations/${MISSING_ID}`,
    ).expect(404);
    await get(support.token, '/platform/lookup/hubs/nope').expect(422);
  });

  it('a regular user and finance get 404 on every lookup and on the audit', async () => {
    for (const token of [owner.token, finance.token]) {
      for (const url of [
        '/platform/lookup/users?email=owner@example.com',
        `/platform/lookup/hubs/${MISSING_ID}`,
        `/platform/lookup/organizations/${MISSING_ID}`,
        '/platform/audit',
      ]) {
        await get(token, url).expect(404);
      }
    }
  });

  it('the audit lists newest first; support sees only the rows of its own requests', async () => {
    const hub = await hk.claim(owner);
    const body = (hubId: string) => ({
      type: 'hub_force_deregister',
      hubId,
      reason: 'Owner lost access to the account',
      evidence: 'Invoice 4567, ID checked, external check #123',
      currentAuthProof: proof,
    });
    const mine = await p
      .createRequest(support.token, body(hub.hubId))
      .expect(201);
    const other = await p
      .createRequest(support2.token, body(hub.hubId))
      .expect(201);
    await p.approveRequest(admin.token, other.body.id, proof).expect(200);

    const all = await get(admin.token, '/platform/audit').expect(200);
    const actions = all.body.items.map((i: { action: string }) => i.action);
    expect(actions.slice(0, 2)).toEqual([
      'platform.request.executed',
      'platform.request.approved',
    ]);
    expect(actions).toContain('platform.request.created');
    const ids = all.body.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual([...ids].sort((a, b) => b.localeCompare(a)));
    expect(all.body.items[0]).toEqual({
      id: expect.any(String),
      action: 'platform.request.executed',
      result: 'success',
      userId: admin.userId,
      supportRequestId: other.body.id,
      targetUserId: null,
      targetHubId: hub.hubId,
      targetOrganizationId: null,
      metadata: expect.any(Object),
      createdAt: expect.stringMatching(/Z$/),
    });

    const own = await get(support.token, '/platform/audit').expect(200);
    expect(
      own.body.items.map(
        (i: { supportRequestId: string }) => i.supportRequestId,
      ),
    ).toEqual([mine.body.id]);
    // Someone else's request id: empty, not an error.
    const foreign = await get(
      support.token,
      `/platform/audit?supportRequestId=${other.body.id}`,
    ).expect(200);
    expect(foreign.body.items).toEqual([]);

    const filtered = await get(
      admin.token,
      `/platform/audit?supportRequestId=${other.body.id}&limit=2`,
    ).expect(200);
    expect(filtered.body.items).toHaveLength(2);
    const next = await get(
      admin.token,
      `/platform/audit?supportRequestId=${other.body.id}&limit=2&cursor=${filtered.body.nextCursor}`,
    ).expect(200);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.nextCursor).toBeNull();
  });
});
