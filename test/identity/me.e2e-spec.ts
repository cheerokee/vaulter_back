import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
  deriveAuthProof,
  openPrivateKey,
  rewrapPrivateKey,
} from '../support/client-crypto.js';
import { identityClient } from '../support/identity-client.js';

const PASSWORD_A = 'correct horse battery staple';
const PASSWORD_B = 'a brand new passphrase';

describe('Me endpoints (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  const c = identityClient(() => app);

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    account = await createClientAccount(PASSWORD_A);
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  it('GET /me returns the logged user without key material or authHash', async () => {
    const reg = await c.register(account, ' Me@Example.com ').expect(201);
    await c.http().get('/me').expect(401);
    const res = await c
      .http()
      .get('/me')
      .set(c.bearer(reg.body.session.accessToken))
      .expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'name',
    ]);
    expect(res.body).toMatchObject({
      id: reg.body.user.id,
      name: 'Ana',
      email: 'me@example.com',
    });
    expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt);
    expect(JSON.stringify(res.body)).not.toMatch(/authHash|kdf|PrivateKey/);
  }, 60_000);

  describe('PUT /me/password', () => {
    const body = async (currentAuthProof: string) => {
      const next = await rewrapPrivateKey(account.privateKey, PASSWORD_B);
      return {
        currentAuthProof,
        newAuthProof: next.authProof,
        newKdfSalt: next.kdfSalt,
        newKdfParams: next.kdfParams,
        newEncryptedPrivateKey: next.encryptedPrivateKey,
      };
    };

    it('change password: new password logs in and opens the same private key; old password fails; other sessions revoked; current session survives', async () => {
      const email = 'change@example.com';
      const d1 = await c.register(account, email).expect(201);
      const d2 = await c
        .login(email, account.authProof, { name: 'iPad', platform: 'ios' })
        .expect(200);
      const h1 = c.bearer(d1.body.session.accessToken);

      const payload = await body(account.authProof);
      await c.http().put('/me/password').set(h1).send(payload).expect(204);

      // New password logs in and yields the same private key.
      const pre = await c
        .http()
        .post('/auth/prelogin')
        .send({ email })
        .expect(200);
      expect(pre.body.kdfSalt).toBe(payload.newKdfSalt);
      const proofB = await deriveAuthProof(
        PASSWORD_B,
        pre.body.kdfSalt,
        pre.body.kdfParams,
      );
      const login = await c.login(email, proofB).expect(200);
      const key = await openPrivateKey(
        PASSWORD_B,
        login.body.keys.kdfSalt,
        login.body.keys.kdfParams,
        login.body.keys.encryptedPrivateKey,
      );
      expect(Buffer.from(key)).toEqual(Buffer.from(account.privateKey));

      // Old password's proof no longer works.
      const old = await c.login(email, account.authProof).expect(401);
      expect(old.body.type).toMatch(/invalid-credentials$/);

      // The other device is out; the device that changed the password stays in.
      await c
        .http()
        .get('/me')
        .set(c.bearer(d2.body.session.accessToken))
        .expect(401);
      await c
        .http()
        .post('/auth/refresh')
        .send({ refreshToken: d2.body.session.refreshToken })
        .expect(401);
      await c.http().get('/me').set(h1).expect(200);
    }, 60_000);

    it('change password with wrong current proof returns 422 current-auth-proof-invalid', async () => {
      const reg = await c.register(account, 'wrong@example.com').expect(201);
      const h = c.bearer(reg.body.session.accessToken);
      const wrong = await c
        .http()
        .put('/me/password')
        .set(h)
        .send(await body('A'.repeat(43)))
        .expect(422);
      expect(wrong.body.type).toMatch(/current-auth-proof-invalid$/);
      expect(wrong.headers['content-type']).toContain(
        'application/problem+json',
      );
      // Nothing changed: the original proof still logs in.
      await c.login('wrong@example.com', account.authProof).expect(200);
      await c
        .http()
        .put('/me/password')
        .send(await body('x'))
        .expect(401);
    }, 60_000);

    it('rejects an incomplete or malformed body with 422 listing fields', async () => {
      const reg = await c.register(account, 'shape@example.com').expect(201);
      const res = await c
        .http()
        .put('/me/password')
        .set(c.bearer(reg.body.session.accessToken))
        .send({ currentAuthProof: account.authProof, extra: 1 })
        .expect(422);
      const fields = res.body.errors.map((e: { field: string }) => e.field);
      expect(fields).toEqual(
        expect.arrayContaining(['newAuthProof', 'newKdfParams', 'extra']),
      );
    }, 60_000);
  });
});
