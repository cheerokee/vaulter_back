import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type request from 'supertest';
import { PLATFORM_PERMISSIONS } from '../../src/platform/domain/platform-catalog.js';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
} from '../support/client-crypto.js';
import { identityClient } from '../support/identity-client.js';
import { keysDeep } from '../support/json-keys.js';
import {
  grantAdminByCli,
  grantRoleInDb,
  platformAuditRows,
  platformClient,
  raceUnderStaffLock,
} from '../support/platform-kit.js';

const PASSWORD = 'correct horse battery staple';
const MISSING_ID = '0190f3c0-0000-7000-8000-000000000000';

describe('Platform staff and roles (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  let other: ClientAccount;
  const c = identityClient(() => app);
  const p = platformClient(() => app);

  beforeAll(async () => {
    app = await createTestApp();
    account = await createClientAccount(PASSWORD);
    other = await createClientAccount(PASSWORD);
  }, 60_000);
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await app.close();
  });

  const signUp = (email: string, name = 'Ana') =>
    c.signUp(account, email, name);

  async function firstAdmin(email = 'admin@example.com') {
    const admin = await signUp(email, 'Admin');
    await grantAdminByCli(email);
    return admin;
  }

  it('a customer gets 404 on GET /platform/me; the routes need a user token', async () => {
    const ana = await signUp('ana@example.com');
    const res = await p.me(ana.token).expect(404);
    expect(res.body.type).toMatch(/\/not-found$/);
    await c.http().get('/platform/me').expect(401);
  });

  it('for a non-staff user a platform route answers exactly like a nonexistent route (no oracle)', async () => {
    const ana = await signUp('ana@example.com');
    const h = c.bearer(ana.token);
    const fake = `/platform/${randomUUID()}`;
    const unknown = await c.http().get(fake).set(h).expect(404);
    expect(unknown.body.detail).toBe(`Cannot GET ${fake}`);
    // Drops what legitimately differs: the request id and the path inside detail.
    const shape = (r: request.Response, path: string) => {
      const { requestId, detail, ...rest } = r.body as Record<string, unknown>;
      expect(requestId).toEqual(expect.any(String));
      return {
        ...rest,
        detail: String(detail).replace(path, '<path>'),
        contentType: r.headers['content-type'],
      };
    };
    const unknownPut = await c
      .http()
      .put(fake)
      .set(h)
      .send({ currentAuthProof: account.authProof })
      .expect(404);
    expect(unknownPut.body.detail).toBe(`Cannot PUT ${fake}`);
    const expected = {
      GET: shape(unknown, fake),
      PUT: shape(unknownPut, fake),
    };
    const grantPath = `/platform/staff/${ana.userId}/roles/platform_admin`;
    const hidden: [request.Response, 'GET' | 'PUT', string][] = [
      [await p.me(ana.token).expect(404), 'GET', '/platform/me'],
      [await p.staff(ana.token).expect(404), 'GET', '/platform/staff'],
      [
        await p
          .grant(ana.token, ana.userId, 'platform_admin', account.authProof)
          .expect(404),
        'PUT',
        grantPath,
      ],
    ];
    for (const [res, method, path] of hidden) {
      expect(res.body.detail).toBe(`Cannot ${method} ${path}`);
      expect(shape(res, path)).toEqual(expected[method]);
    }
  });

  it('the CLI creates the first admin (idempotent, audited with no user and via cli); GET /platform/me lists the 5 permissions', async () => {
    const admin = await firstAdmin('admin@example.com');
    await grantAdminByCli('  ADMIN@example.com'); // same account, normalized; already admin: nothing new
    const res = await p.me(admin.token).expect(200);
    expect(res.body).toEqual({
      roles: ['platform_admin'],
      permissions: [...PLATFORM_PERMISSIONS].sort(),
    });
    const rows = await platformAuditRows();
    expect(rows).toEqual([
      {
        user_id: null,
        action: 'platform.role.granted',
        result: 'success',
        target_user_id: admin.userId,
        metadata: { via: 'cli', roleKey: 'platform_admin' },
      },
    ]);
    await expect(grantAdminByCli('nobody@example.com')).rejects.toThrow(
      /nobody@example\.com/,
    );
  });

  it('an admin gives platform_support; revoking it takes effect on the very next request', async () => {
    const admin = await firstAdmin();
    const bia = await signUp('bia@example.com', 'Bia');
    await p.me(bia.token).expect(404);

    await p
      .grant(admin.token, bia.userId, 'platform_support', account.authProof)
      .expect(204);
    // Idempotent.
    await p
      .grant(admin.token, bia.userId, 'platform_support', account.authProof)
      .expect(204);
    const me = await p.me(bia.token).expect(200);
    expect(me.body).toEqual({
      roles: ['platform_support'],
      permissions: ['platform.audit.read', 'platform.support.request'],
    });

    // Support has no platform.roles.manage: the staff routes do not exist for them.
    await p.staff(bia.token).expect(404);
    await p
      .grant(bia.token, bia.userId, 'platform_admin', account.authProof)
      .expect(404);

    const staff = await p.staff(admin.token).expect(200);
    expect(staff.body).toEqual({
      items: [admin, bia]
        .sort((a, b) => (a.userId < b.userId ? -1 : 1))
        .map((u) => ({
          userId: u.userId,
          name: u === admin ? 'Admin' : 'Bia',
          email: u.email,
          roles: [u === admin ? 'platform_admin' : 'platform_support'],
        })),
      nextCursor: null,
    });
    const page1 = await p.staff(admin.token, { limit: 1 }).expect(200);
    expect(page1.body.items).toHaveLength(1);
    const page2 = await p
      .staff(admin.token, { limit: 1, cursor: page1.body.nextCursor })
      .expect(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
    expect(page2.body.items[0].userId).not.toBe(page1.body.items[0].userId);

    await p
      .revoke(admin.token, bia.userId, 'platform_support', account.authProof)
      .expect(204);
    await p
      .revoke(admin.token, bia.userId, 'platform_support', account.authProof)
      .expect(204);
    await p.me(bia.token).expect(404);

    const rows = await platformAuditRows();
    expect(rows.slice(1)).toEqual([
      {
        user_id: admin.userId,
        action: 'platform.role.granted',
        result: 'success',
        target_user_id: bia.userId,
        metadata: { roleKey: 'platform_support' },
      },
      {
        user_id: admin.userId,
        action: 'platform.role.revoked',
        result: 'success',
        target_user_id: bia.userId,
        metadata: { roleKey: 'platform_support' },
      },
    ]);
  });

  it('the only admin cannot drop their own platform_admin -> 422 last-platform-admin', async () => {
    const admin = await firstAdmin();
    const res = await p
      .revoke(admin.token, admin.userId, 'platform_admin', account.authProof)
      .expect(422);
    expect(res.body.type).toMatch(/\/last-platform-admin$/);
    await p.me(admin.token).expect(200);
  });

  it('two concurrent revocations of the only two admins: one 204, the other 422 last-platform-admin', async () => {
    const a = await firstAdmin('a@example.com');
    const b = await signUp('b@example.com', 'Bruno');
    await grantRoleInDb(b.userId, 'platform_admin');

    // Both requests are held at the lock until both wait on it: a real race, decided by lockAdmins.
    const results = await raceUnderStaffLock(
      () =>
        [a, b].map((u) =>
          Promise.resolve(
            p.revoke(u.token, u.userId, 'platform_admin', account.authProof),
          ),
        ),
      2,
    );
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
      204, 422,
    ]);
    const refused = results.find((r) => r.status === 422)!;
    expect(refused.body.type).toMatch(/\/last-platform-admin$/);
    const still = await Promise.all([p.me(a.token), p.me(b.token)]);
    expect(still.map((r) => r.status).sort((x, y) => x - y)).toEqual([
      200, 404,
    ]);
  });

  it('wrong currentAuthProof -> 422 current-auth-proof-invalid; bad role key -> 422; unknown user -> 404', async () => {
    const admin = await firstAdmin();
    const bia = await signUp('bia@example.com', 'Bia');
    const wrong = await p
      .grant(admin.token, bia.userId, 'platform_support', other.authProof)
      .expect(422);
    expect(wrong.body.type).toMatch(/\/current-auth-proof-invalid$/);
    await p.me(bia.token).expect(404);

    const badRole = await p
      .grant(admin.token, bia.userId, 'org_admin', account.authProof)
      .expect(422);
    expect(badRole.body.type).toMatch(/\/validation-failed$/);
    await p
      .grant(admin.token, 'not-a-uuid', 'platform_support', account.authProof)
      .expect(422);
    const missing = await p
      .grant(admin.token, MISSING_ID, 'platform_support', account.authProof)
      .expect(404);
    expect(missing.body.type).toMatch(/\/user-not-found$/);
    const noProof = await c
      .http()
      .put(`/platform/staff/${bia.userId}/roles/platform_support`)
      .set(c.bearer(admin.token))
      .send({})
      .expect(422);
    expect(noProof.body.type).toMatch(/\/validation-failed$/);
    // Only the CLI row: nothing else was recorded.
    expect(await platformAuditRows()).toHaveLength(1);
  });

  it('a finance member (role without permissions) sees GET /platform/me', async () => {
    const fin = await signUp('fin@example.com', 'Fin');
    await grantRoleInDb(fin.userId, 'platform_finance');
    const res = await p.me(fin.token).expect(200);
    expect(res.body).toEqual({ roles: ['platform_finance'], permissions: [] });
    await p.staff(fin.token).expect(404);
  });

  it('the customer GET /me of a staff member has no key mentioning platform', async () => {
    const admin = await firstAdmin();
    const res = await c
      .http()
      .get('/me')
      .set(c.bearer(admin.token))
      .expect(200);
    expect(
      keysDeep(res.body).filter((k) => k.toLowerCase().includes('platform')),
    ).toEqual([]);
  });
});

describe('Platform routes with the rate limit on (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  const c = identityClient(() => app);
  const p = platformClient(() => app);

  beforeAll(async () => {
    await resetDatabase();
    account = await createClientAccount(PASSWORD);
    app = await createTestApp({ env: { RATE_LIMIT_ENABLED: 'true' } });
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  // Every header the throttler may set (default, user and reauth throttlers) plus Retry-After.
  const rateHeaders = (r: request.Response) =>
    Object.keys(r.headers)
      .filter((h) => h.startsWith('x-ratelimit') || h === 'retry-after')
      .sort();

  it('a hidden platform route sends the same headers as a nonexistent one (no rate-limit oracle, never 429)', async () => {
    const ana = await c.signUp(account, 'ana@example.com', 'Ana');
    const admin = await c.signUp(account, 'admin@example.com', 'Admin');
    await grantAdminByCli('admin@example.com');
    const h = c.bearer(ana.token);
    const fake = `/platform/${randomUUID()}`;

    const unknownGet = await c.http().get(fake).set(h).expect(404);
    expect(rateHeaders(unknownGet)).toEqual([]);
    const me = await p.me(ana.token).expect(404);
    expect(rateHeaders(me)).toEqual(rateHeaders(unknownGet));

    // A reauth route: more calls than the reauth budget (5 per 15 min) and still the plain 404 without headers.
    const grantPath = `/platform/staff/${ana.userId}/roles/platform_admin`;
    for (let i = 0; i < 7; i++) {
      const unknownPut = await c
        .http()
        .put(fake)
        .set(h)
        .send({ currentAuthProof: account.authProof })
        .expect(404);
      const hidden = await p
        .grant(ana.token, ana.userId, 'platform_admin', account.authProof)
        .expect(404);
      expect(hidden.body.detail).toBe(`Cannot PUT ${grantPath}`);
      expect(rateHeaders(hidden)).toEqual(rateHeaders(unknownPut));
      expect(rateHeaders(hidden)).toEqual([]);
    }

    // Control: for staff the throttler still runs (and sets its headers) after the platform guard.
    const staffMe = await p.me(admin.token).expect(200);
    expect(rateHeaders(staffMe).some((x) => x.startsWith('x-ratelimit'))).toBe(
      true,
    );
  });
});
