import type { INestApplication } from '@nestjs/common';
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

describe('rate limiting (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  const c = identityClient(() => app);
  const device = { name: 'Pixel 9', platform: 'android' };
  const loginAs = (email: string, ip?: string) => {
    const req = c.http().post('/auth/login').send({
      email,
      authProof: account.authProof,
      device,
    });
    return ip ? req.set('X-Forwarded-For', ip) : req;
  };

  beforeAll(async () => {
    await resetDatabase();
    account = await createClientAccount('correct horse battery staple');
    app = await createTestApp({
      env: { RATE_LIMIT_ENABLED: 'true', TRUST_PROXY: '1' },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const admin = await adminDataSource();
    await admin.query('TRUNCATE rate_limit_hits');
  });

  it('answers the 11th login of an IP within a minute with 429 problem+json and Retry-After', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await loginAs(`ip-${i}@example.com`, '198.51.100.1');
      expect(res.status).toBe(401);
      expect(
        Object.keys(res.headers).filter(
          (h) => h.startsWith('x-ratelimit') && h.endsWith('-email'),
        ),
      ).toEqual([]);
    }
    const res = await loginAs('ip-10@example.com', '198.51.100.1');
    expect(res.status).toBe(429);
    expect(
      Object.keys(res.headers).filter((h) => h.endsWith('-email')),
    ).toEqual([]);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.type).toMatch(/\/too-many-requests$/);
    expect(res.body.status).toBe(429);
    expect(res.body.requestId).toEqual(expect.any(String));
    const retry = Number(res.headers['retry-after']);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
  }, 60_000);

  it('limits one e-mail to 5 logins a minute across different IPs', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await loginAs('victim@example.com', `203.0.113.${i + 1}`);
      expect(res.status).toBe(401);
    }
    const res = await loginAs('victim@example.com', '203.0.113.99');
    expect(res.status).toBe(429);
    expect(res.body.type).toMatch(/\/too-many-requests$/);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // another e-mail from yet another IP is unaffected
    expect((await loginAs('other@example.com', '203.0.113.100')).status).toBe(
      401,
    );
  }, 60_000);

  it('normalizes the e-mail for the per-e-mail limit', async () => {
    for (let i = 0; i < 5; i++) {
      await loginAs(
        i % 2 ? ' Case@Example.com ' : 'case@example.com',
        `192.0.2.${i + 1}`,
      );
    }
    expect((await loginAs('CASE@example.com', '192.0.2.50')).status).toBe(429);
  }, 60_000);

  it('returns an identical 429 for existing and unknown e-mails', async () => {
    await c.register(account, 'exists@example.com', {}).expect(201);
    const bodies: Record<string, unknown>[] = [];
    for (const email of ['exists@example.com', 'ghost@example.com']) {
      for (let i = 0; i < 5; i++) await loginAs(email, `192.0.2.${100 + i}`);
      const res = await loginAs(email, '192.0.2.200');
      expect(res.status).toBe(429);
      const { requestId: _r, ...rest } = res.body;
      bodies.push(rest);
    }
    expect(bodies[0]).toEqual(bodies[1]);
  }, 60_000);

  it('gives refresh its own limit (60/min per IP)', async () => {
    const send = () =>
      c
        .http()
        .post('/auth/refresh')
        .set('X-Forwarded-For', '198.51.100.7')
        .send({ refreshToken: 'x'.repeat(50) });
    for (let i = 0; i < 60; i++) expect((await send()).status).not.toBe(429);
    expect((await send()).status).toBe(429);
    // login for the same IP is a different counter
    expect((await loginAs('a@example.com', '198.51.100.7')).status).toBe(401);
  }, 60_000);

  it('limits PUT /me/password to 5 per 15 minutes per user, not per IP', async () => {
    const reg = await c.register(account, 'pw@example.com').expect(201);
    const token = reg.body.session.accessToken as string;
    const put = (ip: string, bearer = token) =>
      c
        .http()
        .put('/me/password')
        .set(c.bearer(bearer))
        .set('X-Forwarded-For', ip)
        .send({});
    for (let i = 0; i < 5; i++) {
      expect((await put(`198.51.100.${i + 10}`)).status).not.toBe(429);
    }
    const res = await put('198.51.100.99');
    expect(res.status).toBe(429);
    expect(res.body.type).toMatch(/\/too-many-requests$/);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(60);
  }, 60_000);

  it('shares one per-user reauthentication budget (5 per 15 min) between recovery-key, password, space recovery and its copies', async () => {
    const user = await c.signUp(account, 'reauth@example.com');
    const org = (await c.createOrg(user.token).expect(201)).body.id as string;
    const wrong = await createClientAccount('not the right password');
    const admin = await adminDataSource();
    await admin.query('TRUNCATE rate_limit_hits');
    const recoveryKey = (ip: string) =>
      c
        .http()
        .put(`/organizations/${org}/recovery-key`)
        .set(c.bearer(user.token))
        .set('X-Forwarded-For', ip)
        .send({
          recoveryPublicKey: wrong.publicKey,
          currentAuthProof: wrong.authProof,
        });
    const password = (ip: string) =>
      c
        .http()
        .put('/me/password')
        .set(c.bearer(user.token))
        .set('X-Forwarded-For', ip)
        .send({});
    for (let i = 0; i < 3; i++) {
      const res = await recoveryKey(`198.51.100.${i + 60}`);
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(/current-auth-proof-invalid$/);
    }
    for (let i = 0; i < 2; i++) {
      expect((await password(`198.51.100.${i + 70}`)).status).toBe(422);
    }
    // one counter for the user, whatever the route or the IP
    const rows: { hits: number }[] = await admin.query(
      `SELECT hits FROM rate_limit_hits WHERE key LIKE 'reauth:%'`,
    );
    expect(rows).toEqual([{ hits: 5 }]);
    const recoverSpace = (ip: string) =>
      c
        .http()
        .post('/spaces/0190f3c0-0000-7000-8000-000000000000/recover')
        .set(c.bearer(user.token))
        .set('X-Forwarded-For', ip)
        .send({});
    const recoveryCopies = (ip: string) =>
      c
        .http()
        .post('/spaces/0190f3c0-0000-7000-8000-000000000000/recover/copies')
        .set(c.bearer(user.token))
        .set('X-Forwarded-For', ip)
        .send({});
    for (const res of [
      await recoveryKey('198.51.100.80'),
      await password('198.51.100.81'),
      await recoverSpace('198.51.100.82'),
      await recoveryCopies('198.51.100.83'),
    ]) {
      expect(res.status).toBe(429);
      expect(res.body.type).toMatch(/\/too-many-requests$/);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(60);
    }
  }, 60_000);

  it('limits POST /spaces/:id/keys to 10 per hour per user, on its own counter, whatever the IP', async () => {
    const user = await c.signUp(account, 'rotate-limit@example.com');
    const rotate = (ip: string) =>
      c
        .http()
        .post('/spaces/0190f3c0-0000-7000-8000-000000000000/keys')
        .set(c.bearer(user.token))
        .set('X-Forwarded-For', ip)
        .send({});
    for (let i = 0; i < 10; i++) {
      expect((await rotate(`198.51.100.${i + 110}`)).status).toBe(422);
    }
    const res = await rotate('198.51.100.130');
    expect(res.status).toBe(429);
    expect(res.body.type).toMatch(/\/too-many-requests$/);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(60);
    // another user is not affected
    const other = await c.signUp(account, 'rotate-limit-2@example.com');
    const ok = await c
      .http()
      .post('/spaces/0190f3c0-0000-7000-8000-000000000000/keys')
      .set(c.bearer(other.token))
      .set('X-Forwarded-For', '198.51.100.130')
      .send({});
    expect(ok.status).toBe(422);
  }, 60_000);

  it('authenticates before throttling /me/password (unauthenticated gets 401, never 429)', async () => {
    for (let i = 0; i < 8; i++) {
      const res = await c
        .http()
        .put('/me/password')
        .set('X-Forwarded-For', '198.51.100.250')
        .send({});
      expect(res.status).toBe(401);
    }
  }, 60_000);

  it('applies the global default (300/min) to routes without a specific limit', async () => {
    const reg = await c.register(account, 'plain@example.com').expect(201);
    const token = reg.body.session.accessToken as string;
    const admin = await adminDataSource();
    await admin.query('TRUNCATE rate_limit_hits');
    const get = () =>
      c
        .http()
        .get('/sessions')
        .set(c.bearer(token))
        .set('X-Forwarded-For', '198.51.100.123');
    expect((await get()).status).toBe(200);
    // a different un-overridden route from the same IP shares the same budget
    expect(
      (
        await c
          .http()
          .get('/me')
          .set(c.bearer(token))
          .set('X-Forwarded-For', '198.51.100.123')
      ).status,
    ).toBe(200);
    const rows: { hits: number }[] = await admin.query(
      `SELECT hits FROM rate_limit_hits WHERE key LIKE 'default:%'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hits).toBe(2);
    await admin.query(
      `UPDATE rate_limit_hits SET hits = 300 WHERE key LIKE 'default:%'`,
    );
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.body.type).toMatch(/\/too-many-requests$/);
  }, 60_000);

  it('limits register to 10 per hour per IP (the 11th is 429, even for requests that fail validation)', async () => {
    const send = () =>
      c
        .http()
        .post('/auth/register')
        .set('X-Forwarded-For', '198.51.100.31')
        .send({});
    for (let i = 0; i < 10; i++) expect((await send()).status).toBe(422);
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.body.type).toMatch(/\/too-many-requests$/);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(60);
  }, 60_000);

  it('limits prelogin to 30 per minute per IP (the 31st is 429)', async () => {
    const send = () =>
      c
        .http()
        .post('/auth/prelogin')
        .set('X-Forwarded-For', '198.51.100.32')
        .send({ email: 'pre@example.com' });
    for (let i = 0; i < 30; i++) expect((await send()).status).toBe(200);
    const res = await send();
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);
  }, 60_000);

  it('keeps overridden routes on their own keys, apart from the global per-IP budget', async () => {
    const reg = await c.register(account, 'keys@example.com').expect(201);
    const token = reg.body.session.accessToken as string;
    const admin = await adminDataSource();
    await admin.query('TRUNCATE rate_limit_hits');
    const ip = '198.51.100.33';
    await loginAs('keys@example.com', ip);
    await c
      .http()
      .post('/auth/prelogin')
      .set('X-Forwarded-For', ip)
      .send({ email: 'keys@example.com' });
    await c
      .http()
      .post('/auth/refresh')
      .set('X-Forwarded-For', ip)
      .send({ refreshToken: 'x'.repeat(50) });
    // login (default + email counters), prelogin and refresh each have their own key: 4 rows
    const keys = async () =>
      (await admin.query(
        `SELECT key, hits FROM rate_limit_hits ORDER BY key`,
      )) as { key: string; hits: number }[];
    expect(await keys()).toHaveLength(4);
    for (let i = 0; i < 2; i++) {
      await c
        .http()
        .get('/me')
        .set(c.bearer(token))
        .set('X-Forwarded-For', ip)
        .expect(200);
    }
    // only the global per-IP key is shared by non-overridden routes: one new row, hit twice
    const after = await keys();
    expect(after).toHaveLength(5);
    expect(after.filter((r) => r.hits === 2)).toHaveLength(1);
  }, 60_000);
});
