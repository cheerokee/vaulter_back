import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
} from '../support/client-crypto.js';
import { identityClient } from '../support/identity-client.js';

const FORGED = '203.0.113.9';

async function lastIpAfterForgedLogin(
  app: INestApplication,
  email: string,
  account: ClientAccount,
): Promise<string | null> {
  const c = identityClient(() => app);
  await c.register(account, email).expect(201);
  const login = await c
    .login(email, account.authProof)
    .set('X-Forwarded-For', FORGED)
    .expect(200);
  const list = await c
    .http()
    .get('/sessions')
    .set(c.bearer(login.body.session.accessToken))
    .expect(200);
  const mine = list.body.items.find(
    (i: { id: string }) => i.id === login.body.session.sessionId,
  );
  return mine.lastIp;
}

describe('trust proxy (e2e)', () => {
  let account: ClientAccount;
  beforeAll(async () => {
    await resetDatabase();
    account = await createClientAccount('correct horse battery staple');
  }, 60_000);

  it('ignores a forged X-Forwarded-For with TRUST_PROXY=false', async () => {
    const app = await createTestApp({ env: { TRUST_PROXY: 'false' } });
    try {
      const ip = await lastIpAfterForgedLogin(
        app,
        'tp-false@example.com',
        account,
      );
      expect(ip).not.toBe(FORGED);
      expect(['127.0.0.1', '::1', '::ffff:127.0.0.1']).toContain(ip);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('uses X-Forwarded-For with TRUST_PROXY=1', async () => {
    const app = await createTestApp({ env: { TRUST_PROXY: '1' } });
    try {
      expect(
        await lastIpAfterForgedLogin(app, 'tp-one@example.com', account),
      ).toBe(FORGED);
    } finally {
      await app.close();
    }
  }, 60_000);
});
