import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
} from '../support/client-crypto.js';
import { identityClient } from '../support/identity-client.js';

const PASSWORD = 'correct horse battery staple';
const MISSING_ID = '0190f3c0-0000-7000-8000-000000000000';

describe('Sessions endpoints (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  const c = identityClient(() => app);

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    account = await createClientAccount(PASSWORD);
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  it('lists the user sessions across devices with pagination and marks the current one', async () => {
    const reg = await c.register(account, 'list@example.com').expect(201);
    const second = await c
      .login('list@example.com', account.authProof, {
        name: 'iPad',
        platform: 'ios',
      })
      .expect(200);
    const third = await c
      .login('list@example.com', account.authProof, {
        name: 'Hub',
        platform: 'hub',
      })
      .expect(200);
    const token = reg.body.session.accessToken;

    const page1 = await c
      .http()
      .get('/sessions?limit=2')
      .set(c.bearer(token))
      .expect(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await c
      .http()
      .get(`/sessions?limit=2&cursor=${page1.body.nextCursor}`)
      .set(c.bearer(token))
      .expect(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();

    const items = [...page1.body.items, ...page2.body.items];
    expect(items.map((i: { id: string }) => i.id)).toEqual(
      expect.arrayContaining([
        reg.body.session.sessionId,
        second.body.session.sessionId,
        third.body.session.sessionId,
      ]),
    );
    expect(items).toHaveLength(3);
    const current = items.filter((i: { current: boolean }) => i.current);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(reg.body.session.sessionId);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'current',
          'createdAt',
          'deviceName',
          'devicePlatform',
          'id',
          'lastIp',
          'lastUsedAt',
        ].sort(),
      );
      expect(new Date(item.createdAt).toISOString()).toBe(item.createdAt);
      expect(new Date(item.lastUsedAt).toISOString()).toBe(item.lastUsedAt);
    }
  }, 60_000);

  it('rejects malformed pagination with 422', async () => {
    const reg = await c.register(account, 'page@example.com').expect(201);
    const h = c.bearer(reg.body.session.accessToken);
    await c.http().get('/sessions?cursor=not-a-cursor').set(h).expect(422);
    await c.http().get('/sessions?limit=0').set(h).expect(422);
    await c.http().get('/sessions?limit=101').set(h).expect(422);
    await c.http().get('/sessions?limit=abc').set(h).expect(422);
  }, 60_000);

  it('requires authentication', async () => {
    await c.http().get('/sessions').expect(401);
    await c.http().delete(`/sessions/${MISSING_ID}`).expect(401);
  });

  it('revoking another device session makes its access and refresh tokens fail', async () => {
    const reg = await c.register(account, 'revoke@example.com').expect(201);
    const other = await c
      .login('revoke@example.com', account.authProof, {
        name: 'iPad',
        platform: 'ios',
      })
      .expect(200);
    const h = c.bearer(reg.body.session.accessToken);
    const otherSession = other.body.session;

    await c
      .http()
      .get('/sessions')
      .set(c.bearer(otherSession.accessToken))
      .expect(200);
    await c
      .http()
      .delete(`/sessions/${otherSession.sessionId}`)
      .set(h)
      .expect(204);
    await c
      .http()
      .get('/sessions')
      .set(c.bearer(otherSession.accessToken))
      .expect(401);
    await c
      .http()
      .post('/auth/refresh')
      .send({ refreshToken: otherSession.refreshToken })
      .expect(401);
    // Idempotent, and the caller's own session is untouched.
    await c
      .http()
      .delete(`/sessions/${otherSession.sessionId}`)
      .set(h)
      .expect(204);
    const list = await c.http().get('/sessions').set(h).expect(200);
    expect(list.body.items).toHaveLength(1);
  }, 60_000);

  it('cannot see or revoke sessions of another user (404)', async () => {
    const mine = await c.register(account, 'mine@example.com').expect(201);
    const theirs = await c.register(account, 'theirs@example.com').expect(201);
    const h = c.bearer(mine.body.session.accessToken);

    const list = await c.http().get('/sessions').set(h).expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(
      theirs.body.session.sessionId,
    );

    const res = await c
      .http()
      .delete(`/sessions/${theirs.body.session.sessionId}`)
      .set(h)
      .expect(404);
    expect(res.body.type).toMatch(/session-not-found$/);
    await c
      .http()
      .get('/sessions')
      .set(c.bearer(theirs.body.session.accessToken))
      .expect(200);
    await c.http().delete(`/sessions/${MISSING_ID}`).set(h).expect(404);
  }, 60_000);

  it('malformed session id is a 422 problem', async () => {
    const reg = await c.register(account, 'uuid@example.com').expect(201);
    const res = await c
      .http()
      .delete('/sessions/not-a-uuid')
      .set(c.bearer(reg.body.session.accessToken))
      .expect(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.type).toMatch(/\/validation-failed$/);
    expect(res.body.errors).toEqual([
      { field: 'id', messages: [expect.any(String)] },
    ]);
  }, 60_000);
});
