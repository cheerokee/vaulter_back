import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
  createRecoveryMaterial,
  openRecoveryPrivateKey,
  rewrapPrivateKey,
} from '../support/client-crypto.js';
import { DEFAULT_DEVICE, identityClient } from '../support/identity-client.js';

const PASSWORD_OLD = 'correct horse battery staple';
const PASSWORD_NEW = 'a brand new passphrase after recovery';

describe('Account recovery (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  let other: ClientAccount;
  const c = identityClient(() => app);

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    account = await createClientAccount(PASSWORD_OLD);
    other = await createClientAccount(PASSWORD_OLD);
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  /** What the app does: opens the recovery copy with the code and wraps the private key with a new password. */
  const recoverWithCode = async (
    email: string,
    acc: ClientAccount,
    over: Record<string, unknown> = {},
  ) => {
    const lookup = await c.recoveryLookup(email, acc.recoveryProof).expect(200);
    const privateKey = await openRecoveryPrivateKey(
      acc.recoveryCode,
      lookup.body.recoveryEncryptedPrivateKey as string,
    );
    const next = await rewrapPrivateKey(privateKey, PASSWORD_NEW);
    const res = await c.recoveryComplete({
      email,
      recoveryProof: acc.recoveryProof,
      newAuthProof: next.authProof,
      newKdfSalt: next.kdfSalt,
      newKdfParams: next.kdfParams,
      newEncryptedPrivateKey: next.encryptedPrivateKey,
      device: DEFAULT_DEVICE,
      ...over,
    });
    return { res, privateKey, next };
  };

  it('recovers the account with the code and keeps the same key pair', async () => {
    const email = 'recover@example.com';
    const reg = await c.register(account, email).expect(201);

    // The e-mail is normalized like the login: case and surrounding spaces do not matter.
    const lookup = await c
      .recoveryLookup('  RECOVER@Example.COM ', account.recoveryProof)
      .expect(200);
    expect(Object.keys(lookup.body)).toEqual(['recoveryEncryptedPrivateKey']);
    const privateKey = await openRecoveryPrivateKey(
      account.recoveryCode,
      lookup.body.recoveryEncryptedPrivateKey as string,
    );
    expect(Buffer.from(privateKey)).toEqual(Buffer.from(account.privateKey));

    const next = await rewrapPrivateKey(privateKey, PASSWORD_NEW);
    const done = await c
      .recoveryComplete({
        email: ' Recover@Example.com',
        recoveryProof: account.recoveryProof,
        newAuthProof: next.authProof,
        newKdfSalt: next.kdfSalt,
        newKdfParams: next.kdfParams,
        newEncryptedPrivateKey: next.encryptedPrivateKey,
        device: { name: 'New phone', platform: 'ios' },
      })
      .expect(200);
    expect(done.body.user.id).toBe(reg.body.user.id);
    expect(done.body.keys.publicKey).toBe(reg.body.keys.publicKey);
    expect(done.body.keys.encryptedPrivateKey).toBe(next.encryptedPrivateKey);
    expect(done.body.session.accessToken).toEqual(expect.any(String));
    expect(JSON.stringify(done.body)).not.toMatch(/recovery/i);
    await c
      .http()
      .get('/me')
      .set(c.bearer(done.body.session.accessToken as string))
      .expect(200);

    await c.login(email, next.authProof).expect(200);
    const old = await c.login(email, account.authProof).expect(401);
    expect(old.body.type).toMatch(/\/invalid-credentials$/);

    // The code stays valid after the recovery.
    await c.recoveryLookup(email, account.recoveryProof).expect(200);
  }, 60_000);

  it('revokes every session, including the old refresh tokens', async () => {
    const email = 'sessions@example.com';
    const acc = await createClientAccount(PASSWORD_OLD);
    const s1 = await c.register(acc, email).expect(201);
    const s2 = await c
      .login(email, acc.authProof, { name: 'iPad', platform: 'ios' })
      .expect(200);

    const { res } = await recoverWithCode(email, acc);
    expect(res.status).toBe(200);

    for (const s of [s1, s2]) {
      await c
        .http()
        .post('/auth/refresh')
        .send({ refreshToken: s.body.session.refreshToken })
        .expect(401);
    }
    await c
      .http()
      .get('/me')
      .set(c.bearer(s1.body.session.accessToken as string))
      .expect(401);
    // The new session works.
    await c
      .http()
      .post('/auth/refresh')
      .send({ refreshToken: res.body.session.refreshToken })
      .expect(200);
  }, 60_000);

  it('answers the same 401 for unknown e-mail, wrong proof and wrong-size proof', async () => {
    const email = 'uniform@example.com';
    const acc = await createClientAccount(PASSWORD_OLD);
    await c.register(acc, email).expect(201);
    const next = await rewrapPrivateKey(acc.privateKey, PASSWORD_NEW);
    const material = {
      newAuthProof: next.authProof,
      newKdfSalt: next.kdfSalt,
      newKdfParams: next.kdfParams,
      newEncryptedPrivateKey: next.encryptedPrivateKey,
      device: DEFAULT_DEVICE,
    };
    const attempts = [
      { email: 'nobody@example.com', recoveryProof: acc.recoveryProof },
      { email, recoveryProof: other.recoveryProof },
      { email, recoveryProof: 'A'.repeat(42) },
    ];

    const responses = [];
    for (const a of attempts) {
      responses.push(await c.recoveryLookup(a.email, a.recoveryProof));
      responses.push(await c.recoveryComplete({ ...a, ...material }));
    }
    for (const r of responses) {
      expect(r.status).toBe(401);
      expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(r.body.type).toMatch(/\/recovery-failed$/);
      expect(r.body.detail).toBe(responses[0]!.body.detail);
      expect(JSON.stringify(r.body)).not.toMatch(/recoveryEncryptedPrivateKey/);
    }
    // Nothing changed: the old password still logs in.
    await c.login(email, acc.authProof).expect(200);
  }, 60_000);

  it('rejects invalid new material with 422 before checking the proof and changes nothing', async () => {
    const email = 'material@example.com';
    const acc = await createClientAccount(PASSWORD_OLD);
    const reg = await c.register(acc, email).expect(201);
    const next = await rewrapPrivateKey(acc.privateKey, PASSWORD_NEW);
    const body = (recoveryProof: string) => ({
      email,
      recoveryProof,
      newAuthProof: next.authProof,
      newKdfSalt: next.kdfSalt,
      newKdfParams: {},
      newEncryptedPrivateKey: next.encryptedPrivateKey,
      device: DEFAULT_DEVICE,
    });

    const right = await c.recoveryComplete(body(acc.recoveryProof)).expect(422);
    const wrong = await c
      .recoveryComplete(body(other.recoveryProof))
      .expect(422);
    expect(wrong.body.type).toBe(right.body.type);
    expect(wrong.body.type).not.toMatch(/recovery-failed$/);

    await c
      .http()
      .get('/me')
      .set(c.bearer(reg.body.session.accessToken as string))
      .expect(200);
    await c.login(email, acc.authProof).expect(200);
  }, 60_000);

  it('keeps an open space readable after recovery', async () => {
    const email = 'space-owner@example.com';
    const owner = await c.spaces.signUpKeyed(email);
    const { orgId, kit } = await c.spaces.orgWithKit(owner);
    const {
      res: created,
      key,
      spaceId,
    } = await c.spaces.create(owner, orgId, kit.publicKey);
    expect(created.status).toBe(201);

    const { res, privateKey } = await recoverWithCode(email, owner.account);
    expect(res.status).toBe(200);

    const opened = await c.spaces.openKeys(
      {
        ...owner,
        token: res.body.session.accessToken as string,
        account: { ...owner.account, privateKey },
      },
      spaceId,
    );
    expect(Buffer.from(opened.keys.get(1)!)).toEqual(Buffer.from(key));
  }, 60_000);

  describe('PUT /me/recovery-code', () => {
    it('replaces the recovery code: the old one stops working, the new one recovers', async () => {
      const acc = await createClientAccount(PASSWORD_OLD);
      const email = 'change-code@example.com';
      const reg = await c.register(acc, email).expect(201);
      const token = reg.body.session.accessToken as string;
      const fresh = await createRecoveryMaterial(acc.privateKey);

      await c
        .http()
        .put('/me/recovery-code')
        .set(c.bearer(token))
        .send({
          currentAuthProof: acc.authProof,
          newRecoveryProof: fresh.recoveryProof,
          newRecoveryEncryptedPrivateKey: fresh.recoveryEncryptedPrivateKey,
        })
        .expect(204);

      const old = await c.recoveryLookup(email, acc.recoveryProof).expect(401);
      expect(old.body.type).toMatch(/\/recovery-failed$/);
      const lookup = await c
        .recoveryLookup(email, fresh.recoveryProof)
        .expect(200);
      const opened = await openRecoveryPrivateKey(
        fresh.recoveryCode,
        lookup.body.recoveryEncryptedPrivateKey as string,
      );
      expect(Buffer.from(opened)).toEqual(Buffer.from(acc.privateKey));

      // Sessions are not revoked.
      await c.http().get('/me').set(c.bearer(token)).expect(200);
    }, 60_000);

    it('rejects a wrong current proof and keeps the old code', async () => {
      const acc = await createClientAccount(PASSWORD_OLD);
      const wrong = await createClientAccount('not the right password');
      const email = 'change-code-wrong@example.com';
      const reg = await c.register(acc, email).expect(201);
      const fresh = await createRecoveryMaterial(acc.privateKey);
      const res = await c
        .http()
        .put('/me/recovery-code')
        .set(c.bearer(reg.body.session.accessToken as string))
        .send({
          currentAuthProof: wrong.authProof,
          newRecoveryProof: fresh.recoveryProof,
          newRecoveryEncryptedPrivateKey: fresh.recoveryEncryptedPrivateKey,
        });
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(/current-auth-proof-invalid$/);
      await c.recoveryLookup(email, acc.recoveryProof).expect(200);
    }, 60_000);

    it('keeps the recovery code valid after a password change', async () => {
      const acc = await createClientAccount(PASSWORD_OLD);
      const email = 'code-after-password@example.com';
      const reg = await c.register(acc, email).expect(201);
      const next = await rewrapPrivateKey(acc.privateKey, PASSWORD_NEW);
      await c
        .http()
        .put('/me/password')
        .set(c.bearer(reg.body.session.accessToken as string))
        .send({
          currentAuthProof: acc.authProof,
          newAuthProof: next.authProof,
          newKdfSalt: next.kdfSalt,
          newKdfParams: next.kdfParams,
          newEncryptedPrivateKey: next.encryptedPrivateKey,
        })
        .expect(204);

      const lookup = await c
        .recoveryLookup(email, acc.recoveryProof)
        .expect(200);
      const opened = await openRecoveryPrivateKey(
        acc.recoveryCode,
        lookup.body.recoveryEncryptedPrivateKey as string,
      );
      expect(Buffer.from(opened)).toEqual(Buffer.from(acc.privateKey));
    }, 60_000);
  });
});
