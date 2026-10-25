import type { INestApplication } from '@nestjs/common';
import { ConflictError } from '../../src/shared/domain/errors.js';
import { Session } from '../../src/identity/domain/session.js';
import { SessionRepository } from '../../src/identity/domain/session.repository.js';
import { User } from '../../src/identity/domain/user.js';
import { UserRepository } from '../../src/identity/domain/user.repository.js';
import { DEFAULT_KDF_PARAMS } from '../../src/identity/domain/kdf-params.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';

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
    await users.save(user);
    const v2 = BigInt(await syncVersion(user.id));
    expect(v2).toBeGreaterThan(v1);
    expect((await users.findById(user.id))!.authHash).toBe('new-hash');
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
});
