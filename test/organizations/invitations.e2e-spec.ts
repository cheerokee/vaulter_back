import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
} from '../support/client-crypto.js';
import { identityClient } from '../support/identity-client.js';

const PASSWORD = 'correct horse battery staple';
const WELL_FORMED_UNKNOWN = 'A'.repeat(42) + 'A';

describe('Invitation endpoints (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  const c = identityClient(() => app);
  const preview = (token: string) =>
    c.http().post('/invitations/preview').send({ token });

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    account = await createClientAccount(PASSWORD);
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  it('runs the flow: create, list without secret, public preview without e-mail, accept, consumed', async () => {
    const owner = await c.signUp(account, 'flow-owner@example.com', 'Olivia');
    const guest = await c.signUp(account, 'flow-guest@example.com', 'Guest');
    const org = (await c.createOrg(owner.token, 'Flow Inc').expect(201)).body
      .id as string;

    const created = await c
      .invite(owner.token, org, 'org_member', 'flow-guest@example.com')
      .expect(201);
    const token = created.body.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.body.invitation).toMatchObject({
      organizationId: org,
      roleKey: 'org_member',
      status: 'pending',
      email: 'flow-guest@example.com',
    });
    expect(created.body.invitation.expiresAt).toMatch(/Z$/);

    const list = await c
      .http()
      .get(`/organizations/${org}/invitations`)
      .set(c.bearer(owner.token))
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash|token_hash/);

    const pv = await preview(token).expect(200);
    expect(pv.body).toEqual({
      organizationName: 'Flow Inc',
      invitedByName: 'Olivia',
      expiresAt: expect.stringMatching(/Z$/),
    });
    expect(JSON.stringify(pv.body)).not.toContain('@');

    const acc = await c.acceptInvite(guest.token, token).expect(200);
    expect(acc.body).toEqual({ organizationId: org, roleKey: 'org_member' });
    await c
      .http()
      .get(`/organizations/${org}`)
      .set(c.bearer(guest.token))
      .expect(200);

    const again = await preview(token).expect(422);
    expect(again.body.type).toMatch(/invitation-invalid$/);
    await c.acceptInvite(guest.token, token).expect(422);
    const after = await c
      .http()
      .get(`/organizations/${org}/invitations`)
      .set(c.bearer(owner.token))
      .expect(200);
    expect(after.body.items).toHaveLength(0);
  });

  it('accepting requires login; preview is public; the token is body-only', async () => {
    await c
      .http()
      .post('/invitations/accept')
      .send({ token: WELL_FORMED_UNKNOWN })
      .expect(401);
    await preview(WELL_FORMED_UNKNOWN).expect(422);
    await c.http().get(`/invitations/${WELL_FORMED_UNKNOWN}`).expect(404);
    await c
      .http()
      .post(`/invitations/${WELL_FORMED_UNKNOWN}/accept`)
      .expect(404);
    const doc = await request(app.getHttpServer())
      .get('/docs/json')
      .expect(200);
    const paths = Object.keys(doc.body.paths as Record<string, unknown>);
    expect(paths.filter((p) => p.includes('token'))).toEqual([]);
  });

  it('answers 422 validation for a malformed token and invitation-invalid for unknown ones', async () => {
    const guest = await c.signUp(account, 'fmt@example.com');
    for (const bad of ['', 'short', 'A'.repeat(44), '!'.repeat(43)]) {
      const r = await preview(bad).expect(422);
      expect(r.body.type).toMatch(/validation-failed$/);
    }
    await c.http().post('/invitations/preview').send({}).expect(422);
    const unknown = await c
      .acceptInvite(guest.token, WELL_FORMED_UNKNOWN)
      .expect(422);
    expect(unknown.body.type).toMatch(/invitation-invalid$/);
  });

  it('gives invitation-invalid for revoked, expired and other-email invitations', async () => {
    const owner = await c.signUp(account, 'inv-owner@example.com');
    const guest = await c.signUp(account, 'inv-guest@example.com');
    const org = (await c.createOrg(owner.token).expect(201)).body.id as string;

    const revoked = (await c.invite(owner.token, org).expect(201)).body;
    await c
      .http()
      .delete(`/organizations/${org}/invitations/${revoked.invitation.id}`)
      .set(c.bearer(owner.token))
      .expect(204);
    await c
      .http()
      .delete(`/organizations/${org}/invitations/${revoked.invitation.id}`)
      .set(c.bearer(owner.token))
      .expect(404);
    for (const r of [
      await preview(revoked.token),
      await c.acceptInvite(guest.token, revoked.token),
    ]) {
      expect(r.status).toBe(422);
      expect(r.body.type).toMatch(/invitation-invalid$/);
    }

    const expired = (await c.invite(owner.token, org).expect(201)).body;
    await (
      await adminDataSource()
    ).query(
      `UPDATE organization_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [expired.invitation.id],
    );
    for (const r of [
      await preview(expired.token),
      await c.acceptInvite(guest.token, expired.token),
    ]) {
      expect(r.status).toBe(422);
      expect(r.body.type).toMatch(/invitation-invalid$/);
    }

    const forOther = (
      await c
        .invite(owner.token, org, 'org_member', 'someone-else@example.com')
        .expect(201)
    ).body;
    const wrong = await c.acceptInvite(guest.token, forOther.token).expect(422);
    expect(wrong.body.type).toMatch(/invitation-invalid$/);
    await c
      .http()
      .get(`/organizations/${org}`)
      .set(c.bearer(guest.token))
      .expect(404);
  });

  it('lets only one of two concurrent accepts win', async () => {
    const owner = await c.signUp(account, 'conc-owner@example.com');
    const g1 = await c.signUp(account, 'conc-1@example.com');
    const g2 = await c.signUp(account, 'conc-2@example.com');
    const org = (await c.createOrg(owner.token).expect(201)).body.id as string;
    const { token } = (await c.invite(owner.token, org).expect(201)).body;
    const results = await Promise.all([
      c.acceptInvite(g1.token, token),
      c.acceptInvite(g2.token, token),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 422,
    ]);
    const members = await c
      .http()
      .get(`/organizations/${org}/members`)
      .set(c.bearer(owner.token))
      .expect(200);
    expect(members.body.items).toHaveLength(2);
  });

  it('validates invitation creation input', async () => {
    const owner = await c.signUp(account, 'val-owner@example.com');
    const org = (await c.createOrg(owner.token).expect(201)).body.id as string;
    await c
      .http()
      .post(`/organizations/${org}/invitations`)
      .set(c.bearer(owner.token))
      .send({ roleKey: 'root' })
      .expect(422);
    await c
      .http()
      .post(`/organizations/${org}/invitations`)
      .set(c.bearer(owner.token))
      .send({ roleKey: 'org_member', email: 'nope' })
      .expect(422);
    await c
      .http()
      .delete(`/organizations/${org}/invitations/not-a-uuid`)
      .set(c.bearer(owner.token))
      .expect(422);
  });

  it('keeps these routes out of the public Swagger document', async () => {
    const pub = await request(app.getHttpServer())
      .get('/docs/public/json')
      .expect(200);
    const paths = Object.keys(pub.body.paths as Record<string, unknown>);
    expect(
      paths.filter(
        (p) => p.startsWith('/organizations') || p.startsWith('/invitations'),
      ),
    ).toEqual([]);
    const internal = await request(app.getHttpServer())
      .get('/docs/json')
      .expect(200);
    const ip = Object.keys(internal.body.paths as Record<string, unknown>);
    for (const p of [
      '/organizations',
      '/invitations/preview',
      '/invitations/accept',
    ])
      expect(ip).toContain(p);
  });
});

describe('Invitation rate limits (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  const c = identityClient(() => app);

  beforeAll(async () => {
    await resetDatabase();
    account = await createClientAccount(PASSWORD);
    app = await createTestApp({
      env: { RATE_LIMIT_ENABLED: 'true', TRUST_PROXY: '1' },
    });
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await (await adminDataSource()).query('TRUNCATE rate_limit_hits');
  });

  it('limits the public preview to 30 a minute per IP', async () => {
    const hit = () =>
      c
        .http()
        .post('/invitations/preview')
        .set('X-Forwarded-For', '198.51.100.7')
        .send({ token: WELL_FORMED_UNKNOWN });
    for (let i = 0; i < 30; i++) expect((await hit()).status).toBe(422);
    const res = await hit();
    expect(res.status).toBe(429);
    expect(res.body.type).toMatch(/too-many-requests$/);
    const fresh = await c
      .http()
      .post('/invitations/preview')
      .set('X-Forwarded-For', '198.51.100.8')
      .send({ token: WELL_FORMED_UNKNOWN });
    expect(fresh.status).toBe(422);
  }, 60_000);

  it('limits the accept to 10 a minute per IP', async () => {
    const user = await c.signUp(account, 'rl@example.com');
    const hit = () =>
      c
        .http()
        .post('/invitations/accept')
        .set('X-Forwarded-For', '198.51.100.9')
        .set(c.bearer(user.token))
        .send({ token: WELL_FORMED_UNKNOWN });
    for (let i = 0; i < 10; i++) expect((await hit()).status).toBe(422);
    expect((await hit()).status).toBe(429);
    // the tracker is the IP: the same user from another IP is not throttled
    const other = await c
      .http()
      .post('/invitations/accept')
      .set('X-Forwarded-For', '198.51.100.10')
      .set(c.bearer(user.token))
      .send({ token: WELL_FORMED_UNKNOWN });
    expect(other.status).toBe(422);
  }, 60_000);
});
