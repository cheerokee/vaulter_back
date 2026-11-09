import type { INestApplication } from '@nestjs/common';
import type request from 'supertest';
import type { DataSource } from 'typeorm';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { hubClient } from '../support/hub-client.js';
import type { ClaimedHub } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
} from '../support/identity-client.js';

const UNKNOWN_ID = '0190f3c0-0000-7000-8000-000000000000';

function expect429(res: request.Response): void {
  expect(res.status).toBe(429);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.type).toMatch(/\/too-many-requests$/);
  expect(Number(res.headers['retry-after'])).toBeGreaterThan(60);
}

// Rate limits das rotas de Hub (decisão 10 do plano), com o rate limit ligado e TRUST_PROXY=1 (o IP vem do
// X-Forwarded-For). Também fixa a ordem dos guards: o token de Hub é conferido ANTES do throttler, senão o contador
// por Hub cairia no IP.
describe('hub rate limits (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  const c = identityClient(() => app);
  const h = hubClient(() => app);
  let olivia: KeyedUser;
  let ana: KeyedUser;
  let carl: KeyedUser;
  let dan: KeyedUser;
  let hubA: ClaimedHub;
  let hubB: ClaimedHub;

  const rows = async () =>
    (await admin.query(
      `SELECT key, hits FROM rate_limit_hits ORDER BY key`,
    )) as { key: string; hits: number }[];

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp({
      env: { RATE_LIMIT_ENABLED: 'true', TRUST_PROXY: '1' },
    });
    admin = await adminDataSource();
    olivia = await c.spaces.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await c.spaces.signUpKeyed('ana@example.com', 'Ana');
    carl = await c.spaces.signUpKeyed('carl@example.com', 'Carl');
    dan = await c.spaces.signUpKeyed('dan@example.com', 'Dan');
    hubA = await h.onboard(olivia.token, 'A');
    hubB = await h.onboard(olivia.token, 'B');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await admin.query('TRUNCATE rate_limit_hits');
  });

  it('POST /hub-enrollments: 20 per hour per IP', async () => {
    const send = (ip: string) =>
      h.http().post('/hub-enrollments').set('X-Forwarded-For', ip).send({});
    for (let i = 0; i < 20; i++) {
      expect((await send('198.51.100.1')).status).toBe(422);
    }
    expect429(await send('198.51.100.1'));
    expect((await send('198.51.100.2')).status).toBe(422);
  }, 60_000);

  it('GET /hub-enrollments/:id/status: 120 per hour per IP', async () => {
    const status = (ip: string) =>
      h
        .http()
        .get(`/hub-enrollments/${UNKNOWN_ID}/status`)
        .set('X-Forwarded-For', ip)
        .set('X-Hub-Timestamp', new Date().toISOString())
        .set('X-Hub-Signature', 'x');
    expect((await status('198.51.100.3')).status).toBe(404);
    // one counter for the route and the IP: push it to the limit instead of sending 120 requests
    expect(await rows()).toEqual([{ key: expect.any(String), hits: 1 }]);
    await admin.query(`UPDATE rate_limit_hits SET hits = 120`);
    expect429(await status('198.51.100.3'));
    expect((await status('198.51.100.4')).status).toBe(404);
  }, 60_000);

  it('POST /hub-auth/challenge and /hub-auth/token share ONE budget of 60 per hour per IP', async () => {
    const ip = '198.51.100.5';
    const challenge = () =>
      h
        .http()
        .post('/hub-auth/challenge')
        .set('X-Forwarded-For', ip)
        .send({ hubId: hubA.hubId });
    const token = () =>
      h.http().post('/hub-auth/token').set('X-Forwarded-For', ip).send({});
    for (let i = 0; i < 30; i++) {
      expect((await challenge()).status).toBe(200);
      expect((await token()).status).toBe(422);
    }
    expect(await rows()).toEqual([{ key: expect.any(String), hits: 60 }]);
    expect429(await challenge());
    expect429(await token());
    expect(
      (
        await h
          .http()
          .post('/hub-auth/challenge')
          .set('X-Forwarded-For', '198.51.100.6')
          .send({ hubId: hubA.hubId })
      ).status,
    ).toBe(200);
  }, 60_000);

  const claimFrom = (u: KeyedUser, ip: string) =>
    h
      .http()
      .post('/hubs/claim')
      .set(c.bearer(u.token))
      .set('X-Forwarded-For', ip)
      .send({ claimCode: '00000000', name: 'X' });

  it('POST /hubs/claim: 10 per hour per user, whatever the IP', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await claimFrom(olivia, `198.51.100.${i + 10}`)).status).toBe(
        422,
      );
    }
    expect429(await claimFrom(olivia, '198.51.100.30'));
    expect((await claimFrom(ana, '198.51.100.30')).status).toBe(422);
  }, 60_000);

  it('POST /hubs/claim: also 30 per hour per IP, whatever the user (accounts do not add up)', async () => {
    const ip = '198.51.100.31';
    for (const u of [olivia, ana, carl]) {
      for (let i = 0; i < 10; i++) {
        expect((await claimFrom(u, ip)).status).toBe(422);
      }
    }
    // a fourth account, below its own per-user limit, is blocked by the IP counter...
    expect429(await claimFrom(dan, ip));
    // ...and on another IP it still gets through
    expect((await claimFrom(dan, '198.51.100.32')).status).toBe(422);
  }, 60_000);

  it('POST /hubs/link-requests: 10 per hour per user, whatever the IP', async () => {
    const send = (u: KeyedUser, ip: string) =>
      h
        .http()
        .post('/hubs/link-requests')
        .set(c.bearer(u.token))
        .set('X-Forwarded-For', ip)
        .send({ linkCode: '00000000', organizationId: UNKNOWN_ID });
    for (let i = 0; i < 10; i++) {
      expect((await send(olivia, `198.51.100.${i + 40}`)).status).toBe(404);
    }
    expect429(await send(olivia, '198.51.100.60'));
    expect((await send(ana, '198.51.100.60')).status).toBe(404);
  }, 60_000);

  it('POST /hub/link-codes: 30 per hour per hub, whatever the IP; another hub on the same IP is not affected', async () => {
    const tokenA = await h.authenticate(hubA);
    const tokenB = await h.authenticate(hubB);
    await admin.query('TRUNCATE rate_limit_hits');
    const send = (token: string, ip: string) =>
      h.linkCode(token).set('X-Forwarded-For', ip);
    for (let i = 0; i < 30; i++) {
      expect((await send(tokenA, `198.51.100.${i + 70}`)).status).toBe(201);
    }
    expect429(await send(tokenA, '198.51.100.120'));
    expect((await send(tokenB, '198.51.100.120')).status).toBe(201);
  }, 60_000);

  it('GET /hub/sync: 120 per hour per hub; the hub guard runs before the throttler (two hubs behind one IP do not share)', async () => {
    const tokenA = await h.authenticate(hubA);
    const tokenB = await h.authenticate(hubB);
    await admin.query('TRUNCATE rate_limit_hits');
    const ip = '198.51.100.130';
    const sync = (token: string, at = ip) =>
      h.sync(token).set('X-Forwarded-For', at);
    await expectStatus(sync(tokenA), 200);
    expect(await rows()).toEqual([{ key: expect.any(String), hits: 1 }]);
    await admin.query(`UPDATE rate_limit_hits SET hits = 120`);
    // the counter belongs to hub A, on any IP...
    expect429(await sync(tokenA));
    expect429(await sync(tokenA, '198.51.100.131'));
    // ...and hub B, from the SAME IP, has its own: with the throttler before the hub guard, `request.hub` would be
    // unset, both would fall back to the IP key and hub B would get 429 here
    await expectStatus(sync(tokenB), 200);
    // without a valid hub token: 401 from the guard, never a throttled 429
    for (const bad of ['', 'Bearer x', `Bearer ${olivia.token}`]) {
      const res = await h
        .http()
        .get('/hub/sync')
        .set('X-Forwarded-For', ip)
        .set(bad ? { Authorization: bad } : {});
      expect(res.status).toBe(401);
      expect(res.body.type).toMatch(/\/invalid-hub-token$/);
    }
  }, 60_000);

  describe('POST /hub/user-sessions (person login through the hub)', () => {
    const proof = 'A'.repeat(43);
    const loginOn = (token: string, email: string, ip = '198.51.100.140') =>
      h
        .http()
        .post('/hub/user-sessions')
        .set(h.bearer(token))
        .set('X-Forwarded-For', ip)
        .send({ email, authProof: proof, device: { name: 'Sala' } });
    const expect429PerMinute = (res: request.Response) => {
      expect(res.status).toBe(429);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.type).toMatch(/\/too-many-requests$/);
      const retry = Number(res.headers['retry-after']);
      expect(retry).toBeGreaterThan(0);
      expect(retry).toBeLessThanOrEqual(60);
    };

    it('10 per minute per hub, whatever the IP; another hub is not affected', async () => {
      const tokenA = await h.authenticate(hubA);
      const tokenB = await h.authenticate(hubB);
      await admin.query('TRUNCATE rate_limit_hits');
      // A different e-mail each time: only the per-hub counter grows.
      for (let i = 0; i < 10; i++) {
        expect(
          (
            await loginOn(
              tokenA,
              `nobody${i}@example.com`,
              `198.51.100.${150 + i}`,
            )
          ).status,
        ).toBe(401);
      }
      expect429PerMinute(
        await loginOn(tokenA, 'nobody-x@example.com', '198.51.100.170'),
      );
      expect(
        (await loginOn(tokenB, 'nobody-y@example.com', '198.51.100.150'))
          .status,
      ).toBe(401);
    }, 60_000);

    it('5 per minute per normalized e-mail across hubs, a counter of its own (the /auth/login one is untouched)', async () => {
      const tokenA = await h.authenticate(hubA);
      const tokenB = await h.authenticate(hubB);
      await admin.query('TRUNCATE rate_limit_hits');
      for (let i = 0; i < 5; i++) {
        const token = i % 2 === 0 ? tokenA : tokenB;
        const email = i % 2 === 0 ? ana.email : `  ${ana.email.toUpperCase()} `;
        expect((await loginOn(token, email)).status).toBe(401);
      }
      expect429PerMinute(await loginOn(tokenB, ana.email, '198.51.100.171'));
      // The same e-mail on /auth/login has its own budget.
      const direct = await c
        .http()
        .post('/auth/login')
        .set('X-Forwarded-For', '198.51.100.172')
        .send({
          email: ana.email,
          authProof: ana.account.authProof,
          device: { name: 'Phone', platform: 'android' },
        });
      expect(direct.status).toBe(200);
    }, 60_000);
  });
});
