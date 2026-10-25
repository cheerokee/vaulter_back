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
    }
    const res = await loginAs('ip-10@example.com', '198.51.100.1');
    expect(res.status).toBe(429);
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
    const rows: { hits: number }[] = await admin.query(
      `SELECT hits FROM rate_limit_hits WHERE key LIKE 'default:%'`,
    );
    expect(rows).toHaveLength(1);
    await admin.query(
      `UPDATE rate_limit_hits SET hits = 300 WHERE key LIKE 'default:%'`,
    );
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.body.type).toMatch(/\/too-many-requests$/);
  }, 60_000);
});
