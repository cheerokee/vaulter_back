import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Session } from '../../src/identity/domain/session.js';
import { SessionRepository } from '../../src/identity/domain/session.repository.js';
import { User } from '../../src/identity/domain/user.js';
import { UserRepository } from '../../src/identity/domain/user.repository.js';
import { DEFAULT_KDF_PARAMS } from '../../src/identity/domain/kdf-params.js';
import { ConflictError } from '../../src/shared/domain/errors.js';
import { newId } from '../../src/shared/domain/id.js';
import { enableOrganizationRls } from '../../src/shared/infra/db/migration-helpers.js';
import { runInOrganizationScope } from '../../src/shared/infra/db/organization-scope.js';
import {
  UnitOfWork,
  currentManager,
} from '../../src/shared/infra/db/unit-of-work.js';
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

const now = new Date('2026-10-25T12:00:00.000Z');

const makeUser = (email = 'ana@x.com') =>
  User.register({
    name: 'Ana',
    email,
    authHash: '$argon2id$v=19$m=19456,t=2,p=1$fake',
    kdfSalt: b64(16),
    kdfParams: { ...DEFAULT_KDF_PARAMS },
    publicKey: b64(32),
    encryptedPrivateKey: b64(73, 0x01),
    now,
  });

const makeSession = (userId: string, hash = 'h1') =>
  Session.start({
    userId,
    deviceName: 'Pixel',
    devicePlatform: 'android',
    refreshTokenHash: hash,
    idleDays: 30,
    now,
    ip: '1.2.3.4',
    userAgent: 'ua',
  });

describe('UnitOfWork (e2e)', () => {
  let app: INestApplication;
  let uow: UnitOfWork;
  let ds: DataSource;
  let users: UserRepository;
  let sessions: SessionRepository;
  const orgA = newId();
  const orgB = newId();

  beforeAll(async () => {
    app = await createTestApp();
    uow = app.get(UnitOfWork);
    ds = app.get(DataSource);
    users = app.get(UserRepository, { strict: false });
    sessions = app.get(SessionRepository, { strict: false });

    const admin = await adminDataSource();
    await admin.query('DROP TABLE IF EXISTS uow_rls_probe');
    await admin.query(
      'CREATE TABLE uow_rls_probe (id uuid PRIMARY KEY, organization_id uuid NOT NULL, v text)',
    );
    const qr = admin.createQueryRunner();
    await enableOrganizationRls(qr, 'uow_rls_probe');
    await qr.release();
  });

  afterAll(async () => {
    const admin = await adminDataSource();
    await admin.query('DROP TABLE IF EXISTS uow_rls_probe');
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    const admin = await adminDataSource();
    await admin.query(
      `INSERT INTO uow_rls_probe (id, organization_id, v) VALUES ($1, $2, 'a1'), ($3, $4, 'b1')`,
      [newId(), orgA, newId(), orgB],
    );
  });

  const countRows = async (table: string, id: string): Promise<number> => {
    const admin = await adminDataSource();
    const rows: { n: number }[] = await admin.query(
      `SELECT count(*)::int AS n FROM "${table}" WHERE id = $1`,
      [id],
    );
    return rows[0]!.n;
  };

  it('runs on the app role (RLS applies)', async () => {
    const rows: { r: string }[] = await ds.query('SELECT current_user AS r');
    expect(rows[0]!.r).toBe(process.env.DB_APP_USERNAME);
  });

  it('commits writes of two repositories made inside run', async () => {
    const user = makeUser();
    const session = makeSession(user.id);
    await uow.run(async () => {
      await users.create(user);
      await sessions.create(session);
    });
    expect(await countRows('users', user.id)).toBe(1);
    expect(await countRows('user_sessions', session.id)).toBe(1);
  });

  it('rolls back writes of two repositories when the work throws', async () => {
    const user = makeUser();
    const session = makeSession(user.id);
    await expect(
      uow.run(async () => {
        await users.create(user);
        await sessions.create(session);
        // Visível dentro da própria transação.
        expect(await users.findById(user.id)).not.toBeNull();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await countRows('users', user.id)).toBe(0);
    expect(await countRows('user_sessions', session.id)).toBe(0);
  });

  it('a nested run reuses the same transaction', async () => {
    const txid = () =>
      currentManager(ds)
        .query('SELECT txid_current()::text AS t')
        .then((r: { t: string }[]) => r[0]!.t);
    const [outer, inner] = await uow.run(async () => {
      const o = await txid();
      const i = await uow.run(txid);
      return [o, i];
    });
    expect(inner).toBe(outer);
  });

  it('a failure in a nested run rolls back the outer work too', async () => {
    const user = makeUser();
    await expect(
      uow.run(async () => {
        await users.create(user);
        await uow.run(() => Promise.reject(new Error('inner')));
      }),
    ).rejects.toThrow('inner');
    expect(await countRows('users', user.id)).toBe(0);
  });

  it('a caught failure in a nested run is rolled back to its savepoint; the outer still commits', async () => {
    const first = makeUser('first@x.com');
    const insideFailed = makeUser('inner@x.com');
    const last = makeUser('last@x.com');
    await uow.run(async () => {
      await users.create(first);
      // Erro de banco (23505 traduzido para ConflictError) num run aninhado, capturado.
      await expect(
        uow.run(() => users.create(makeUser('first@x.com'))),
      ).rejects.toBeInstanceOf(ConflictError);
      // Erro de aplicação depois de gravar, capturado: a gravação interna é desfeita.
      await expect(
        uow.run(async () => {
          await users.create(insideFailed);
          throw new Error('inner');
        }),
      ).rejects.toThrow('inner');
      await users.create(last);
    });
    expect(await countRows('users', first.id)).toBe(1);
    expect(await countRows('users', insideFailed.id)).toBe(0);
    expect(await countRows('users', last.id)).toBe(1);
  });

  it('a database error swallowed without a nested run makes run reject (no silent rollback)', async () => {
    const user = makeUser();
    await expect(
      uow.run(async () => {
        await users.create(user);
        try {
          await users.create(makeUser());
        } catch {
          // engolido de propósito: a transação ficou abortada
        }
        return 'looks fine';
      }),
    ).rejects.toMatchObject({ code: '25P02' });
    expect(await countRows('users', user.id)).toBe(0);
  });

  it('concurrent runs keep their own organization context', async () => {
    const list = (orgId: string) =>
      uow.run(async () => {
        await uow.setContext({ organizationId: orgId });
        await currentManager(ds).query('SELECT pg_sleep(0.05)');
        return (
          (await currentManager(ds).query('SELECT v FROM uow_rls_probe')) as {
            v: string;
          }[]
        ).map((r) => r.v);
      });
    const [a, b] = await Promise.all([list(orgA), list(orgB)]);
    expect(a).toEqual(['a1']);
    expect(b).toEqual(['b1']);
  });

  it('a nested organization scope restores the outer context when it returns', async () => {
    const probe = () =>
      currentManager(ds)
        .query('SELECT v FROM uow_rls_probe ORDER BY v')
        .then((r: { v: string }[]) => r.map((x) => x.v));
    const seen = await uow.run(async () => {
      await uow.setContext({ organizationId: orgA });
      const inner = await runInOrganizationScope(ds, orgB, () => probe());
      const afterScope = await probe();
      const fromWith = await uow.withContext({ organizationId: orgB }, probe);
      const afterWith = await probe();
      return { inner, afterScope, fromWith, afterWith };
    });
    expect(seen).toEqual({
      inner: ['b1'],
      afterScope: ['a1'],
      fromWith: ['b1'],
      afterWith: ['a1'],
    });
  });

  it('a nested organization scope that fails also restores the outer context', async () => {
    const seen = await uow.run(async () => {
      await uow.setContext({ organizationId: orgA });
      await expect(
        runInOrganizationScope(ds, orgB, () =>
          Promise.reject(new Error('inner')),
        ),
      ).rejects.toThrow('inner');
      return currentManager(ds).query('SELECT v FROM uow_rls_probe');
    });
    expect(seen).toEqual([{ v: 'a1' }]);
  });

  it('withContext outside run opens its own transaction with the context', async () => {
    const rows = await uow.withContext({ organizationId: orgB }, () =>
      currentManager(ds).query('SELECT v FROM uow_rls_probe'),
    );
    expect(rows).toEqual([{ v: 'b1' }]);
  });

  it('currentManager outside run is the data source manager', () => {
    expect(currentManager(ds)).toBe(ds.manager);
  });

  it('setContext outside run throws', async () => {
    await expect(uow.setContext({ organizationId: orgA })).rejects.toThrow(
      /active unit of work/,
    );
  });

  it('setContext({ organizationId }) makes RLS filter by organization', async () => {
    const rows = await uow.run(async () => {
      await uow.setContext({ organizationId: orgA });
      return currentManager(ds).query(
        'SELECT organization_id, v FROM uow_rls_probe ORDER BY v',
      );
    });
    expect(rows).toEqual([{ organization_id: orgA, v: 'a1' }]);
    // Sem contexto (e fora da transação anterior), nada aparece.
    expect(await ds.query('SELECT * FROM uow_rls_probe')).toEqual([]);
    expect(
      await uow.run(() =>
        currentManager(ds).query('SELECT * FROM uow_rls_probe'),
      ),
    ).toEqual([]);
  });

  it('setContext ignores invitationTokenHash (only withContext scopes it)', async () => {
    const rows = await uow.run(async () => {
      await uow.setContext({
        invitationTokenHash: 'abc',
      } as unknown as Parameters<UnitOfWork['setContext']>[0]);
      return currentManager(ds).query(
        `SELECT COALESCE(current_setting('app.invitation_token_hash', true), '') AS v`,
      );
    });
    expect(rows[0].v).toBe('');
  });

  it('setContext({ userId }) sets app.user_id for the transaction only', async () => {
    const userId = newId();
    const inside = await uow.run(async () => {
      await uow.setContext({ userId });
      return currentManager(ds).query(
        `SELECT current_setting('app.user_id', true) AS u, current_setting('app.organization_id', true) AS o`,
      );
    });
    expect(inside[0].u).toBe(userId);
    expect(inside[0].o ?? '').toBe('');
    const after: { u: string | null }[] = await ds.query(
      `SELECT current_setting('app.user_id', true) AS u`,
    );
    expect(after[0]!.u ?? '').toBe('');
  });

  it('runInOrganizationScope joins an ambient unit of work', async () => {
    const result = await uow.run(async () => {
      const outer: { t: string }[] = await currentManager(ds).query(
        'SELECT txid_current()::text AS t',
      );
      const inner = await runInOrganizationScope(ds, orgB, async (m) => ({
        t: (
          (await m.query('SELECT txid_current()::text AS t')) as {
            t: string;
          }[]
        )[0]!.t,
        rows: (await m.query('SELECT v FROM uow_rls_probe')) as {
          v: string;
        }[],
      }));
      return { outer: outer[0]!.t, inner };
    });
    expect(result.inner.t).toBe(result.outer);
    expect(result.inner.rows).toEqual([{ v: 'b1' }]);
  });

  it('conditional updates keep their semantics inside a unit of work', async () => {
    const user = makeUser();
    await users.create(user);
    const session = makeSession(user.id, 'h1');
    await sessions.create(session);
    session.rotate('h2', 30, now, null, null);
    const [first, second, revoked, revokedAgain] = await uow.run(async () => [
      await sessions.rotateRefreshToken(session, 'h1'),
      await sessions.rotateRefreshToken(session, 'h1'),
      await sessions.revoke(session.id, 'logout', now),
      await sessions.revoke(session.id, 'revoked', now),
    ]);
    expect([first, second, revoked, revokedAgain]).toEqual([
      true,
      false,
      true,
      false,
    ]);
    const loaded = (await sessions.findById(session.id))!;
    expect(loaded.refreshTokenHash).toBe('h2');
    expect(loaded.revokedReason).toBe('logout');
  });
});
