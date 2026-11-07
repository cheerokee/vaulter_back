import type { INestApplication } from '@nestjs/common';
import { ConflictError } from '../../src/shared/domain/errors.js';
import { Session } from '../../src/identity/domain/session.js';
import { SessionRepository } from '../../src/identity/domain/session.repository.js';
import { User } from '../../src/identity/domain/user.js';
import { UserRepository } from '../../src/identity/domain/user.repository.js';
import { DEFAULT_KDF_PARAMS } from '../../src/identity/domain/kdf-params.js';
import { UnitOfWork } from '../../src/shared/infra/db/unit-of-work.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { testRecoveryFields } from '../support/client-crypto.js';

const b64 = (n: number, first?: number) => {
  const b = Buffer.alloc(n, 0xab);
  if (first !== undefined) b[0] = first;
  return b.toString('base64url');
};

const makeUser = (email = 'ana@x.com') =>
  User.register({
    name: 'Ana',
    email,
    authHash: '$argon2id$v=19$m=19456,t=2,p=1$fake',
    kdfSalt: b64(16),
    kdfParams: { ...DEFAULT_KDF_PARAMS },
    publicKey: b64(32),
    encryptedPrivateKey: b64(73, 0x01),
    ...testRecoveryFields(),
    now: new Date('2026-10-24T12:34:56.789Z'),
  });

const now = new Date('2026-10-24T12:00:00.000Z');
const makeSession = (userId: string, hash = 'h1', id?: string) =>
  Session.start({
    id,
    userId,
    deviceName: 'Pixel',
    devicePlatform: 'android',
    refreshTokenHash: hash,
    idleDays: 30,
    now,
    ip: '1.2.3.4',
    userAgent: 'ua',
  });

describe('identity repositories', () => {
  let app: INestApplication;
  let users: UserRepository;
  let sessions: SessionRepository;

  beforeAll(async () => {
    app = await createTestApp();
    users = app.get(UserRepository, { strict: false });
    sessions = app.get(SessionRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  const syncVersion = async (id: string): Promise<string> => {
    const ds = await adminDataSource();
    const rows: { sync_version: string }[] = await ds.query(
      'SELECT sync_version FROM users WHERE id = $1',
      [id],
    );
    return rows[0]!.sync_version;
  };

  it('persists and reloads a user with identical fields', async () => {
    const user = makeUser();
    await users.create(user);
    const loaded = await users.findById(user.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(user.id);
    expect(loaded!.name).toBe('Ana');
    expect(loaded!.email).toBe('ana@x.com');
    expect(loaded!.authHash).toBe(user.authHash);
    expect(loaded!.kdfSalt).toBe(user.kdfSalt);
    expect(loaded!.kdfParams).toEqual(DEFAULT_KDF_PARAMS);
    expect(loaded!.publicKey).toBe(user.publicKey);
    expect(loaded!.encryptedPrivateKey).toBe(user.encryptedPrivateKey);
    expect(loaded!.recoveryHash).toBe(user.recoveryHash);
    expect(loaded!.recoveryEncryptedPrivateKey).toBe(
      user.recoveryEncryptedPrivateKey,
    );
    expect(loaded!.createdAt).toEqual(user.createdAt);
    expect(loaded!.createdAt!.toISOString()).toBe('2026-10-24T12:34:56.789Z');
    expect((await users.findByEmail('ana@x.com'))!.id).toBe(user.id);
    expect(await users.findByEmail('nobody@x.com')).toBeNull();
  });

  it('assigns sync_version on insert and bumps it on update', async () => {
    const user = makeUser();
    await users.create(user);
    const v1 = BigInt(await syncVersion(user.id));
    user.changePassword({
      authHash: 'new-hash',
      kdfSalt: b64(16),
      kdfParams: { ...DEFAULT_KDF_PARAMS },
      encryptedPrivateKey: b64(73, 0x01),
    });
    await users.updatePasswordMaterial(user);
    const v2 = BigInt(await syncVersion(user.id));
    expect(v2).toBeGreaterThan(v1);
    expect((await users.findById(user.id))!.authHash).toBe('new-hash');
  });

  it('per-field writes: a stale password change never restores the old recovery code, and vice versa', async () => {
    const user = makeUser();
    await users.create(user);
    // Two flows read the same row before either writes (the lost-update scenario).
    const forPassword = (await users.findById(user.id))!;
    const forRecovery = (await users.findById(user.id))!;

    const newBlob = Buffer.alloc(73, 0x09);
    newBlob[0] = 0x01;
    forRecovery.changeRecoveryCode({
      recoveryHash: 'cd'.repeat(32),
      recoveryEncryptedPrivateKey: newBlob.toString('base64url'),
    });
    await users.updateRecoveryCode(forRecovery);

    const epk = Buffer.alloc(73, 0x07);
    epk[0] = 0x01;
    const newEpk = epk.toString('base64url');
    forPassword.changePassword({
      authHash: 'new-hash',
      kdfSalt: b64(16, 0x05),
      kdfParams: { ...DEFAULT_KDF_PARAMS, opsLimit: 4 },
      encryptedPrivateKey: newEpk,
    });
    await users.updatePasswordMaterial(forPassword);

    const loaded = (await users.findById(user.id))!;
    expect(loaded.authHash).toBe('new-hash');
    expect(loaded.kdfSalt).toBe(b64(16, 0x05));
    expect(loaded.kdfParams).toEqual({ ...DEFAULT_KDF_PARAMS, opsLimit: 4 });
    expect(loaded.encryptedPrivateKey).toBe(newEpk);
    expect(loaded.recoveryHash).toBe('cd'.repeat(32));
    expect(loaded.recoveryEncryptedPrivateKey).toBe(
      newBlob.toString('base64url'),
    );

    // The other order: a stale recovery-code change never restores the old password material.
    const staleForCode = (await users.findById(user.id))!;
    const freshForPassword = (await users.findById(user.id))!;
    freshForPassword.changePassword({
      authHash: 'newer-hash',
      kdfSalt: b64(16, 0x06),
      kdfParams: { ...DEFAULT_KDF_PARAMS },
      encryptedPrivateKey: b64(73, 0x01),
    });
    await users.updatePasswordMaterial(freshForPassword);
    staleForCode.changeRecoveryCode({
      recoveryHash: 'ef'.repeat(32),
      recoveryEncryptedPrivateKey: b64(73, 0x01),
    });
    await users.updateRecoveryCode(staleForCode);

    const after = (await users.findById(user.id))!;
    expect(after.authHash).toBe('newer-hash');
    expect(after.kdfSalt).toBe(b64(16, 0x06));
    expect(after.recoveryHash).toBe('ef'.repeat(32));
  });

  it('findByIdForUpdate locks the row inside a unit of work', async () => {
    const user = makeUser();
    await users.create(user);
    const uow = app.get(UnitOfWork, { strict: false });
    const locked = await uow.run(async () => {
      const row = await users.findByIdForUpdate(user.id);
      const ds = await adminDataSource();
      // Another connection cannot take the same lock while this transaction holds it.
      const other: unknown[] = await ds.query(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE SKIP LOCKED',
        [user.id],
      );
      expect(other).toHaveLength(0);
      return row;
    });
    expect(locked!.id).toBe(user.id);
    expect(
      await uow.run(() =>
        users.findByIdForUpdate('0190f3a0-0000-7000-8000-000000000000'),
      ),
    ).toBeNull();
  });

  it('rejects a second active user with the same email with ConflictError', async () => {
    await users.create(makeUser());
    const err = await users.create(makeUser()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).code).toBe('email-already-registered');
  });

  it('allows reusing the email of a soft-deleted user', async () => {
    const first = makeUser();
    await users.create(first);
    const ds = await adminDataSource();
    await ds.query('UPDATE users SET deleted_at = now() WHERE id = $1', [
      first.id,
    ]);
    const second = makeUser();
    await users.create(second);
    expect((await users.findByEmail('ana@x.com'))!.id).toBe(second.id);
  });

  it('lists only active sessions of the user, newest first, with cursor', async () => {
    const user = makeUser();
    const other = makeUser('bia@x.com');
    await users.create(user);
    await users.create(other);
    const active = [1, 2, 3].map(() => makeSession(user.id));
    for (const s of active) await sessions.create(s);
    const revoked = makeSession(user.id);
    revoked.revoke('logout', now);
    await sessions.create(revoked);
    const expired = Session.start({
      userId: user.id,
      deviceName: 'old',
      devicePlatform: 'web',
      refreshTokenHash: 'x',
      idleDays: 1,
      now: new Date('2020-01-01T00:00:00Z'),
      ip: null,
      userAgent: null,
    });
    await sessions.create(expired);
    await sessions.create(makeSession(other.id));

    const expectedIds = active
      .map((s) => s.id)
      .sort()
      .reverse();
    const page1 = await sessions.listActiveByUser(user.id, now, { limit: 2 });
    expect(page1.items.map((s) => s.id)).toEqual(expectedIds.slice(0, 2));
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await sessions.listActiveByUser(user.id, now, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((s) => s.id)).toEqual(expectedIds.slice(2));
    expect(page2.nextCursor).toBeNull();
  });

  it('rotateRefreshToken succeeds once and fails for a stale hash', async () => {
    const user = makeUser();
    await users.create(user);
    const session = makeSession(user.id, 'h1');
    await sessions.create(session);
    const later = new Date(now.getTime() + 1000);
    session.rotate('h2', 30, later, '5.6.7.8', 'ua2');
    expect(await sessions.rotateRefreshToken(session, 'h1')).toBe(true);
    expect(await sessions.rotateRefreshToken(session, 'h1')).toBe(false);
    const loaded = (await sessions.findById(session.id))!;
    expect(loaded.refreshTokenHash).toBe('h2');
    expect(loaded.lastIp).toBe('5.6.7.8');
    expect(loaded.lastUsedAt).toEqual(later);
  });

  it('concurrent rotations with the same expected hash: exactly one wins', async () => {
    const user = makeUser();
    await users.create(user);
    const session = makeSession(user.id, 'h1');
    await sessions.create(session);
    const a = (await sessions.findById(session.id))!;
    const b = (await sessions.findById(session.id))!;
    a.rotate('ha', 30, now, null, null);
    b.rotate('hb', 30, now, null, null);
    const results = await Promise.all([
      sessions.rotateRefreshToken(a, 'h1'),
      sessions.rotateRefreshToken(b, 'h1'),
    ]);
    expect([...results].sort((x, y) => Number(x) - Number(y))).toEqual([
      false,
      true,
    ]);
  });

  it('revokeAllForUser keeps the excepted session active', async () => {
    const user = makeUser();
    await users.create(user);
    const keep = makeSession(user.id);
    const drop = makeSession(user.id);
    const already = makeSession(user.id);
    already.revoke('logout', now);
    for (const s of [keep, drop, already]) await sessions.create(s);
    const later = new Date(now.getTime() + 5000);
    await sessions.revokeAllForUser(user.id, 'password_change', later, keep.id);
    expect((await sessions.findById(keep.id))!.revokedAt).toBeNull();
    const d = (await sessions.findById(drop.id))!;
    expect(d.revokedReason).toBe('password_change');
    expect(d.revokedAt).toEqual(later);
    expect((await sessions.findById(already.id))!.revokedReason).toBe('logout');
  });

  it('revoke is atomic and first-reason-wins', async () => {
    const user = makeUser();
    await users.create(user);
    const session = makeSession(user.id);
    await sessions.create(session);
    const first = new Date(now.getTime() + 1000);
    const second = new Date(now.getTime() + 2000);
    expect(await sessions.revoke(session.id, 'logout', first)).toBe(true);
    expect(await sessions.revoke(session.id, 'revoked', second)).toBe(false);
    const loaded = (await sessions.findById(session.id))!;
    expect(loaded.revokedReason).toBe('logout');
    expect(loaded.revokedAt).toEqual(first);
    expect(
      await sessions.revoke(
        '00000000-0000-7000-8000-000000000000',
        'logout',
        first,
      ),
    ).toBe(false);
  });

  it('revoke after a concurrent rotation keeps the rotated hash', async () => {
    const user = makeUser();
    await users.create(user);
    const session = makeSession(user.id, 'h1');
    await sessions.create(session);
    const stale = (await sessions.findById(session.id))!;
    session.rotate('h2', 30, now, null, null);
    expect(await sessions.rotateRefreshToken(session, 'h1')).toBe(true);
    expect(await sessions.revoke(stale.id, 'refresh_reuse', now)).toBe(true);
    const loaded = (await sessions.findById(session.id))!;
    expect(loaded.refreshTokenHash).toBe('h2');
    expect(loaded.revokedReason).toBe('refresh_reuse');
  });

  it('saves a new recovery code and accepts the account_recovery revoke reason', async () => {
    const user = makeUser();
    await users.create(user);
    const blob = Buffer.alloc(73, 0x09);
    blob[0] = 0x01;
    user.changeRecoveryCode({
      recoveryHash: 'y'.repeat(64),
      recoveryEncryptedPrivateKey: blob.toString('base64url'),
    });
    await users.updateRecoveryCode(user);
    const loaded = (await users.findById(user.id))!;
    expect(loaded.recoveryHash).toBe('y'.repeat(64));
    expect(loaded.recoveryEncryptedPrivateKey).toBe(blob.toString('base64url'));
    expect(loaded.encryptedPrivateKey).toBe(user.encryptedPrivateKey);

    const session = makeSession(user.id);
    await sessions.create(session);
    expect(await sessions.revoke(session.id, 'account_recovery', now)).toBe(
      true,
    );
    expect((await sessions.findById(session.id))!.revokedReason).toBe(
      'account_recovery',
    );
  });
});
