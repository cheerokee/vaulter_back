import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RegistrationHooks } from '../../src/shared/application/registration-hooks.js';
import { AccessTokenService } from '../../src/identity/application/ports/access-token-service.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
  deriveAuthProof,
  openPrivateKey,
  TEST_KDF_PARAMS,
} from '../support/client-crypto.js';

const PASSWORD = 'correct horse battery staple';
const DEVICE = { name: 'Pixel 9', platform: 'android' };

describe('Auth endpoints (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;

  const http = () => request(app.getHttpServer());
  const registerBody = (email: string, over: Record<string, unknown> = {}) => ({
    name: 'Ana',
    email,
    authProof: account.authProof,
    kdfSalt: account.kdfSalt,
    kdfParams: account.kdfParams,
    publicKey: account.publicKey,
    encryptedPrivateKey: account.encryptedPrivateKey,
    device: DEVICE,
    ...over,
  });
  const register = (email: string, over: Record<string, unknown> = {}) =>
    http().post('/auth/register').send(registerBody(email, over));
  const login = (email: string, authProof = account.authProof) =>
    http().post('/auth/login').send({ email, authProof, device: DEVICE });
  const logout = (token?: string) =>
    http()
      .post('/auth/logout')
      .set(token ? { Authorization: `Bearer ${token}` } : {});

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    account = await createClientAccount(PASSWORD);
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  it('register → prelogin → login with the derived proof opens the private key on the client', async () => {
    const reg = await register('flow@example.com').expect(201);
    expect(reg.body.user).toMatchObject({
      name: 'Ana',
      email: 'flow@example.com',
    });
    expect(JSON.stringify(reg.body)).not.toContain('authHash');
    expect(new Date(reg.body.session.accessTokenExpiresAt).toISOString()).toBe(
      reg.body.session.accessTokenExpiresAt,
    );

    const pre = await http()
      .post('/auth/prelogin')
      .send({ email: 'flow@example.com' })
      .expect(200);
    expect(pre.body).toEqual({
      kdfSalt: account.kdfSalt,
      kdfParams: TEST_KDF_PARAMS,
    });
    const proof = await deriveAuthProof(
      PASSWORD,
      pre.body.kdfSalt,
      pre.body.kdfParams,
    );
    const res = await login('flow@example.com', proof).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('authHash');
    const key = await openPrivateKey(
      PASSWORD,
      res.body.keys.kdfSalt,
      res.body.keys.kdfParams,
      res.body.keys.encryptedPrivateKey,
    );
    expect(Buffer.from(key)).toEqual(Buffer.from(account.privateKey));
  }, 60_000);

  it('treats email case and surrounding spaces as the same account', async () => {
    await register(' Ana@X.com ').expect(201);
    const pre = await http()
      .post('/auth/prelogin')
      .send({ email: 'ana@x.com' })
      .expect(200);
    expect(pre.body.kdfSalt).toBe(account.kdfSalt);
    await login('ana@x.com').expect(200);
    await register('ANA@x.com').expect(409);
  }, 60_000);

  it('prelogin for unknown email is deterministic and indistinguishable in shape', async () => {
    const a1 = await http()
      .post('/auth/prelogin')
      .send({ email: 'ghost@example.com' })
      .expect(200);
    const a2 = await http()
      .post('/auth/prelogin')
      .send({ email: 'ghost@example.com' })
      .expect(200);
    const b = await http()
      .post('/auth/prelogin')
      .send({ email: 'other-ghost@example.com' })
      .expect(200);
    expect(a1.body).toEqual(a2.body);
    expect(a1.body.kdfSalt).not.toBe(b.body.kdfSalt);
    expect(a1.body.kdfSalt).toHaveLength(22);
    expect(a1.body.kdfParams).toEqual({
      algorithm: 'argon2id13',
      opsLimit: 3,
      memLimitBytes: 67108864,
    });
    const real = await http()
      .post('/auth/prelogin')
      .send({ email: 'flow@example.com' })
      .expect(200);
    expect(Object.keys(real.body).sort()).toEqual(Object.keys(a1.body).sort());
  });

  it('login with unknown email and with wrong proof return the same 401 type', async () => {
    const wrong = await login('flow@example.com', 'A'.repeat(43)).expect(401);
    const unknown = await login('nobody@example.com').expect(401);
    const malformedLength = await login('flow@example.com', 'AAAA').expect(401);
    expect(wrong.headers['content-type']).toContain('application/problem+json');
    expect(unknown.body.type).toBe(wrong.body.type);
    expect(malformedLength.body.type).toBe(wrong.body.type);
    expect(wrong.body.type).toMatch(/invalid-credentials$/);
    // DTO-level format violation is an edge contract error (ruling D).
    await login('flow@example.com', 'not base64url!').expect(422);
  });

  describe('malformed key material', () => {
    // 135 chars and valid for @IsEmail (its limits are in bytes), but 'İ' lowercases to 2 UTF-16
    // units, so the normalized e-mail has 260 > 255 characters.
    const DOTTED_LABEL = '\u0130'.repeat(31) + 'a';
    const LONG_DOTTED_EMAIL = `${'\u0130'.repeat(32)}@${Array(3).fill(DOTTED_LABEL).join('.')}.com`;
    const b64 = (bytes: Buffer) => bytes.toString('base64url');
    const cases: [string, Record<string, unknown>, string][] = [
      [
        'encryptedPrivateKey with padding',
        { encryptedPrivateKey: b64(Buffer.alloc(73, 1)) + '=' },
        // '=' is outside the base64url alphabet, so the DTO rejects it before the domain does.
        'validation-failed',
      ],
      [
        'encryptedPrivateKey with version 0x02',
        { encryptedPrivateKey: b64(Buffer.alloc(73, 2)) },
        'encrypted-private-key-invalid',
      ],
      [
        'kdfParams with an extra key',
        { kdfParams: { ...TEST_KDF_PARAMS, extra: 1 } },
        'kdf-params-invalid',
      ],
      [
        'publicKey of 31 bytes',
        { publicKey: b64(Buffer.alloc(31, 1)) },
        'public-key-invalid',
      ],
      [
        'email that grows past 255 chars when lowercased',
        { email: LONG_DOTTED_EMAIL },
        'email-invalid',
      ],
    ];

    it.each(cases)('%s → 422 with its stable type', async (_l, over, type) => {
      const res = await register('bad@example.com', over);
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(new RegExp(`/${type}$`));
      expect(res.headers['content-type']).toContain('application/problem+json');
    });

    it('over-long normalized e-mail creates no user and never 500s on login or pre-login', async () => {
      const res = await register(LONG_DOTTED_EMAIL).expect(422);
      expect(res.body.type).toMatch(/\/email-invalid$/);
      const ds = await adminDataSource();
      const rows = await ds.query("SELECT 1 FROM users WHERE email LIKE 'a@%'");
      expect(rows).toHaveLength(0);
      await login(LONG_DOTTED_EMAIL).expect(401);
      const pre = await http()
        .post('/auth/prelogin')
        .send({ email: LONG_DOTTED_EMAIL });
      expect(pre.status).toBeLessThan(500);
    });

    it('name of 1 MB → 413 or 422, never 500', async () => {
      const res = await register('big@example.com', {
        name: 'x'.repeat(1024 * 1024),
      });
      expect([413, 422]).toContain(res.status);
      expect(res.headers['content-type']).toContain('application/problem+json');
    });

    it('name of 300 chars → 422 listing the field', async () => {
      const res = await register('long@example.com', {
        name: 'x'.repeat(300),
      }).expect(422);
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(
        'name',
      );
    });
  });

  describe('device is required', () => {
    const loginBody = (device?: unknown) => ({
      email: 'flow@example.com',
      authProof: account.authProof,
      ...(device === undefined ? {} : { device }),
    });

    it.each([
      ['missing', undefined],
      ['an array', []],
      ['an array with an object', [DEVICE]],
    ])(
      'register with device %s → 422 listing device, no user created',
      async (_l, device) => {
        const body: Record<string, unknown> = registerBody(
          'nodevice@example.com',
        );
        if (device === undefined) delete body.device;
        else body.device = device;
        const res = await http().post('/auth/register').send(body).expect(422);
        expect(
          res.body.errors.map((e: { field: string }) => e.field),
        ).toContain('device');
        const ds = await adminDataSource();
        const rows = await ds.query('SELECT 1 FROM users WHERE email = $1', [
          'nodevice@example.com',
        ]);
        expect(rows).toHaveLength(0);
      },
    );

    it.each([
      ['missing', undefined],
      ['an array', []],
    ])('login with device %s → 422 listing device', async (_l, device) => {
      const res = await http()
        .post('/auth/login')
        .send(loginBody(device))
        .expect(422);
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(
        'device',
      );
    });
  });

  it('malformed JSON → 400 problem+json, never 500', async () => {
    const res = await http()
      .post('/auth/prelogin')
      .set('Content-Type', 'application/json')
      .send('{"email": ')
      .expect(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects unknown body fields with 422', async () => {
    const res = await register('extra@example.com', { admin: true }).expect(
      422,
    );
    expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(
      'admin',
    );
  });

  it('refresh rotates; reusing the old refresh token revokes the session', async () => {
    const reg = await register('rotate@example.com').expect(201);
    const first = reg.body.session;
    const second = (
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(200)
    ).body;
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // Reuse of the old token: 401 and the whole session is revoked.
    const reuse = await http()
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(401);
    expect(reuse.body.type).toMatch(/invalid-refresh-token$/);
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: second.refreshToken })
      .expect(401);
    await logout(second.accessToken).expect(401);
  }, 60_000);

  it('two concurrent refreshes with the same token leave no usable session', async () => {
    const reg = await register('race@example.com').expect(201);
    const { refreshToken, accessToken } = reg.body.session;
    const results = await Promise.all([
      http().post('/auth/refresh').send({ refreshToken }),
      http().post('/auth/refresh').send({ refreshToken }),
    ]);
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(
      1,
    );
    for (const r of results) expect([200, 401]).toContain(r.status);
    for (const r of results) {
      if (r.status === 200) {
        await http()
          .post('/auth/refresh')
          .send({ refreshToken: r.body.refreshToken })
          .expect(401);
        await logout(r.body.accessToken).expect(401);
      }
    }
    await logout(accessToken).expect(401);
  }, 60_000);

  describe('protected routes', () => {
    const noneToken = () => {
      const part = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: 'x', sid: 'y' })}.`;
    };

    it('without, with malformed, with alg none or expired token returns 401 problem+json', async () => {
      const reg = await register('guard@example.com').expect(201);
      const { sessionId } = reg.body.session;
      const tokens = app.get(AccessTokenService);
      const expired = await tokens.issue(
        { userId: reg.body.user.id, sessionId },
        new Date(Date.now() - 3_600_000),
      );
      const attempts: (string | undefined)[] = [
        undefined,
        'garbage',
        noneToken(),
        expired.token,
      ];
      for (const [i, token] of attempts.entries()) {
        const res = await logout(token).expect(401);
        expect(res.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(res.body.type).toMatch(/invalid-access-token$/);
        expect(res.body.requestId, `attempt ${i}`).toBeTruthy();
      }
      // Wrong scheme.
      const res = await http()
        .post('/auth/logout')
        .set('Authorization', `Basic ${reg.body.session.accessToken}`)
        .expect(401);
      expect(res.body.type).toMatch(/invalid-access-token$/);
      // The scheme name is case-insensitive.
      await http()
        .post('/auth/logout')
        .set('Authorization', `bearer ${reg.body.session.accessToken}`)
        .expect(204);
    }, 60_000);

    it('keeps public routes and documents open without a token', async () => {
      await http().get('/').expect(200);
      await http().get('/docs/public/json').expect(200);
    });
  });

  it('logout revokes the session immediately', async () => {
    const reg = await register('bye@example.com').expect(201);
    const { accessToken } = reg.body.session;
    await logout(accessToken).expect(204);
    await logout(accessToken).expect(401);
  }, 60_000);

  describe('registration hooks', () => {
    const usersCount = async () => {
      const ds = await adminDataSource();
      const rows: { n: string }[] = await ds.query(
        'SELECT count(*)::text AS n FROM users',
      );
      return Number(rows[0]!.n);
    };
    const tableCount = async (table: 'user_sessions' | 'organizations') => {
      const ds = await adminDataSource();
      const rows: { n: string }[] = await ds.query(
        `SELECT count(*)::text AS n FROM ${table}`,
      );
      return Number(rows[0]!.n);
    };

    it('a throwing hook rolls the whole registration back (no user row)', async () => {
      const hooks = app.get(RegistrationHooks);
      hooks.register({
        name: 'test-throwing',
        onRegistered: async () => {
          throw new Error('hook exploded');
        },
      });
      try {
        const before = await usersCount();
        const sessionsBefore = await tableCount('user_sessions');
        const orgsBefore = await tableCount('organizations');
        const res = await register('hook-fail@example.com');
        expect(res.status).toBe(500);
        expect(res.text).not.toContain('hook exploded');
        expect(res.body).toMatchObject({
          status: 500,
          detail: 'An unexpected error occurred',
        });
        expect(await usersCount()).toBe(before);
        expect(await tableCount('user_sessions')).toBe(sessionsBefore);
        expect(await tableCount('organizations')).toBe(orgsBefore);
      } finally {
        hooks.unregister('test-throwing');
      }
      // Same e-mail registers fine once the hook is gone: nothing was left behind.
      await register('hook-fail@example.com').expect(201);
    }, 60_000);

    it('surfaces the hook result as invitation, only when present (real organizations hook)', async () => {
      const hooks = app.get(RegistrationHooks);
      let seen: string | undefined;
      // Hook that only observes (returns nothing): the organizations hook owns `invitation`.
      hooks.register({
        name: 'test-invite-spy',
        onRegistered: async (ctx) => {
          seen = ctx.inviteToken;
        },
      });
      try {
        // Well-formed for the DTO but unknown: registration goes on with accepted:false.
        const withToken = await register('hook-inv@example.com', {
          inviteToken: 'abc_DEF-123',
        }).expect(201);
        expect(seen).toBe('abc_DEF-123');
        expect(withToken.body.invitation).toEqual({ accepted: false });
        const without = await register('hook-noinv@example.com').expect(201);
        expect('invitation' in without.body).toBe(false);
        // Every registration gets its personal organization.
        const ds = await adminDataSource();
        const rows: { n: string }[] = await ds.query(
          `SELECT count(*)::text AS n FROM organizations o
             JOIN users u ON u.id = o.personal_owner_user_id
            WHERE u.email IN ('hook-inv@example.com', 'hook-noinv@example.com') AND o.is_personal`,
        );
        expect(Number(rows[0]!.n)).toBe(2);
      } finally {
        hooks.unregister('test-invite-spy');
      }
    }, 60_000);

    it('rejects a malformed inviteToken with 422', async () => {
      await register('hook-bad@example.com', {
        inviteToken: 'bad token!',
      }).expect(422);
    }, 60_000);
  });
});
