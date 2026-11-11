import type { INestApplication } from '@nestjs/common';
import sodium from 'libsodium-wrappers-sumo';
import { ServerKeyring } from '../../src/cloud/application/ports/server-keyring.js';
import { UnitOfWork } from '../../src/shared/infra/db/unit-of-work.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { identityClient } from '../support/identity-client.js';

/** What the app does: `0x01 ‖ crypto_box_seal(key, serverPublicKey)`, base64url (108 chars). */
function sealForServer(key: Uint8Array, serverPublicKey: string): string {
  const sealed = sodium.crypto_box_seal(
    key,
    Buffer.from(serverPublicKey, 'base64url'),
  );
  return Buffer.concat([Buffer.from([0x01]), sealed]).toString('base64url');
}

describe('cloud server key (e2e, KMS on LocalStack)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);

  beforeAll(async () => {
    await sodium.ready;
    await resetDatabase();
    // The server key is server data, not client data: resetDatabase empties it too (a new pair per spec file).
    app = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('GET /cloud/server-key needs a user token', async () => {
    await c.http().get('/cloud/server-key').expect(401);
  });

  it('no phantom key: a first use inside a unit of work that rolls back creates nothing; the route hands out a persisted key', async () => {
    const admin = await adminDataSource();
    const count = async () =>
      (
        (await admin.query(
          `SELECT count(*)::int AS n FROM cloud_server_keys`,
        )) as { n: number }[]
      )[0]!.n;
    expect(await count()).toBe(0);
    const keyring = app.get(ServerKeyring);
    const other = sodium.crypto_box_keypair();
    const foreign = sealForServer(
      sodium.randombytes_buf(32),
      Buffer.from(other.publicKey).toString('base64url'),
    );
    await expect(
      app.get(UnitOfWork).run(async () => {
        // A copy checked under a request's transaction (activation, rotation, conversation create) never creates
        // the key, and neither does asking for it there.
        await expect(keyring.openSealed(foreign)).rejects.toMatchObject({
          code: 'server-copy-invalid',
        });
        await expect(keyring.publicKey()).rejects.toThrow(
          /never created inside a unit of work/,
        );
        await expect(keyring.prepare()).rejects.toThrow(
          /before the unit of work/,
        );
        throw new Error('the request fails');
      }),
    ).rejects.toThrow('the request fails');
    expect(await count()).toBe(0);

    const ana = await c.spaces.signUpKeyed('kiosk-free@example.com');
    const res = await c
      .http()
      .get('/cloud/server-key')
      .set({ Authorization: `Bearer ${ana.token}` })
      .expect(200);
    const rows: { public_key: string }[] = await admin.query(
      `SELECT public_key FROM cloud_server_keys WHERE retired_at IS NULL`,
    );
    expect(rows.map((r) => r.public_key)).toEqual([res.body.publicKey]);
    // Prepared outside, a copy sealed to it opens inside a unit of work (from memory).
    await keyring.prepare();
    const key = sodium.randombytes_buf(32);
    const copy = sealForServer(key, res.body.publicKey);
    const opened = await app
      .get(UnitOfWork)
      .run(() => keyring.openSealed(copy));
    expect(Buffer.from(opened).equals(Buffer.from(key))).toBe(true);
  });

  it('returns only the public key, and a copy sealed to it opens to the same 32 bytes', async () => {
    const ana = await c.spaces.signUpKeyed('ana@example.com');
    const res = await c
      .http()
      .get('/cloud/server-key')
      .set({ Authorization: `Bearer ${ana.token}` })
      .expect(200);
    expect(Object.keys(res.body)).toEqual(['publicKey']);
    expect(res.body.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const spaceKey = sodium.randombytes_buf(32);
    const copy = sealForServer(spaceKey, res.body.publicKey);
    expect(copy).toHaveLength(108);
    const opened = await app.get(ServerKeyring).openSealed(copy);
    expect(Buffer.from(opened).equals(Buffer.from(spaceKey))).toBe(true);
  });

  it('refuses a copy sealed to another key, with the same 422 as a malformed one', async () => {
    const keyring = app.get(ServerKeyring);
    const other = sodium.crypto_box_keypair();
    const wrong = sealForServer(
      sodium.randombytes_buf(32),
      Buffer.from(other.publicKey).toString('base64url'),
    );
    await expect(keyring.openSealed(wrong)).rejects.toMatchObject({
      code: 'server-copy-invalid',
    });
    await expect(keyring.openSealed('x'.repeat(108))).rejects.toMatchObject({
      code: 'server-copy-invalid',
    });
  });

  it('stores only the KMS ciphertext, and a restarted process opens the same key', async () => {
    const before = await app.get(ServerKeyring).publicKey();
    const admin = await adminDataSource();
    const rows: {
      public_key: string;
      encrypted_private_key: string;
      kms_key_arn: string;
      retired_at: Date | null;
    }[] = await admin.query(
      `SELECT public_key, encrypted_private_key, kms_key_arn, retired_at FROM cloud_server_keys`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ public_key: before, retired_at: null });
    expect(rows[0]!.kms_key_arn).toMatch(/^arn:aws:kms:/);
    // A KMS blob (key id + IV + ciphertext + tag), never a bare 32-byte key.
    expect(
      Buffer.from(rows[0]!.encrypted_private_key, 'base64').length,
    ).toBeGreaterThan(32);

    const spaceKey = sodium.randombytes_buf(32);
    const copy = sealForServer(spaceKey, before);
    await app.close();
    app = await createTestApp();
    const keyring = app.get(ServerKeyring);
    expect(await keyring.publicKey()).toBe(before);
    expect(Buffer.from(await keyring.openSealed(copy))).toEqual(
      Buffer.from(spaceKey),
    );
  }, 60_000);

  it('the runtime login cannot rewrite the stored key (only retire it)', async () => {
    const admin = await adminDataSource();
    const [{ ok }] = (await admin.query(
      `SELECT has_column_privilege('app_runtime', 'cloud_server_keys', 'encrypted_private_key', 'UPDATE') AS ok`,
    )) as [{ ok: boolean }];
    expect(ok).toBe(false);
    const [{ retire }] = (await admin.query(
      `SELECT has_column_privilege('app_runtime', 'cloud_server_keys', 'retired_at', 'UPDATE') AS retire`,
    )) as [{ retire: boolean }];
    expect(retire).toBe(true);
  });

  it('rotation: after retiring the key, a new instance hands out a new one that the running instance opens', async () => {
    const running = app.get(ServerKeyring);
    const k1 = await running.publicKey();
    const old = sodium.randombytes_buf(32);
    const oldCopy = sealForServer(old, k1);
    const admin = await adminDataSource();
    await admin.query(
      `UPDATE cloud_server_keys SET retired_at = now() WHERE retired_at IS NULL`,
    );

    const other = await createTestApp();
    try {
      const k2 = await other.get(ServerKeyring).publicKey();
      expect(k2).not.toBe(k1);
      const fresh = sodium.randombytes_buf(32);
      // The running instance has K1 cached as current, yet opens a copy sealed to K2 (reload on miss)...
      expect(
        Buffer.from(await running.openSealed(sealForServer(fresh, k2))),
      ).toEqual(Buffer.from(fresh));
      // ...and both still open copies sealed to the retired K1.
      for (const keyring of [running, other.get(ServerKeyring)]) {
        expect(Buffer.from(await keyring.openSealed(oldCopy))).toEqual(
          Buffer.from(old),
        );
      }
      const rows: { n: number }[] = await admin.query(
        `SELECT count(*)::int AS n FROM cloud_server_keys WHERE retired_at IS NULL`,
      );
      expect(rows[0]!.n).toBe(1);
    } finally {
      await other.close();
    }
  }, 60_000);
});
