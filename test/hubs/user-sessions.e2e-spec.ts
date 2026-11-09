import type { INestApplication } from '@nestjs/common';
import type request from 'supertest';
import type { DataSource } from 'typeorm';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { hubClient } from '../support/hub-client.js';
import type { ClaimedHub } from '../support/hubs-kit.js';
import { withOwnerClient } from '../support/platform-kit.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
} from '../support/identity-client.js';

type SessionRow = {
  hub_id: string | null;
  device_platform: string;
  revoked_reason: string | null;
};

/** The problem body without the per-request id, after checking status and stable `type`. */
function problem(res: request.Response, status: number, type: string) {
  if (res.status !== status) {
    throw new Error(
      `expected ${status} ${type}, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  expect(res.body.type).toMatch(new RegExp(`/${type}$`));
  const { requestId: _r, ...rest } = res.body as Record<string, unknown>;
  return rest;
}

// Login de pessoas pelo Hub (spec storage-backup §4.7): só quem tem papel no Hub (dono, explícito ou implícito por
// organização vinculada) abre sessão pelo `POST /hub/user-sessions`, com o token de Hub; a sessão fica presa ao Hub e
// cai (`hub_access_lost`) quando a pessoa perde o acesso a ele. O `/auth/login` recusa `platform: 'hub'`.
describe('person login through the hub (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const as = (u: KeyedUser) => c.bearer(u.token);

  let olivia: KeyedUser; // dona dos Hubs
  let ana: KeyedUser; // membro de organização vinculada
  let bia: KeyedUser; // membro com papel explícito
  let carl: KeyedUser; // sem papel em Hub nenhum

  const sessionRow = async (sessionId: string): Promise<SessionRow> => {
    const rows: SessionRow[] = await admin.query(
      `SELECT hub_id, device_platform, revoked_reason FROM user_sessions WHERE id = $1`,
      [sessionId],
    );
    return rows[0]!;
  };
  const refresh = (refreshToken: string) =>
    c.http().post('/auth/refresh').send({ refreshToken });
  const phoneLogin = async (u: KeyedUser) =>
    (await expectStatus(c.login(u.email, u.account.authProof), 200)).body
      .session as { sessionId: string; refreshToken: string };

  /** A hub of Olivia linked (approved) to a new organization with the given members. */
  const linkedHub = async (name: string, members: KeyedUser[]) => {
    const o = await s.orgWithKit(olivia, name);
    for (const u of members) await s.joinOrg(olivia, o.orgId, u);
    const hub = await h.onboard(olivia.token, name);
    await expectStatus(
      c
        .http()
        .post(`/hubs/${hub.hubId}/organizations`)
        .set(as(olivia))
        .send({ organizationId: o.orgId }),
      201,
    );
    return { orgId: o.orgId, hub, hubToken: await h.authenticate(hub) };
  };
  const loginOn = (hubToken: string, u: KeyedUser) =>
    h.loginPerson(hubToken, u.email, u.account.authProof);
  const loggedIn = async (hubToken: string, u: KeyedUser) =>
    (await expectStatus(loginOn(hubToken, u), 200)).body.session as {
      sessionId: string;
      refreshToken: string;
      accessToken: string;
    };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = await adminDataSource();
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    bia = await s.signUpKeyed('bia@example.com', 'Bia');
    carl = await s.signUpKeyed('carl@example.com', 'Carl');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('POST /hub/user-sessions', () => {
    let hub: ClaimedHub;
    let hubToken: string;
    beforeAll(async () => {
      ({ hub, hubToken } = await linkedHub('Login', [ana]));
    });

    it('a member of a linked organization logs in; the session is bound to the hub', async () => {
      const res = await expectStatus(loginOn(hubToken, ana), 200);
      expect(Object.keys(res.body).sort()).toEqual(['keys', 'session', 'user']);
      expect(res.body.user.id).toBe(ana.userId);
      expect(res.body.keys.publicKey).toBe(ana.account.publicKey);
      expect(await sessionRow(res.body.session.sessionId)).toEqual({
        hub_id: hub.hubId,
        device_platform: 'hub',
        revoked_reason: null,
      });
      // A sessão é uma sessão comum de usuário: o token de acesso abre as rotas de usuário.
      await expectStatus(
        c.http().get('/me').set(c.bearer(res.body.session.accessToken)),
        200,
      );
    });

    it('the owner logs in too', async () => {
      await expectStatus(loginOn(hubToken, olivia), 200);
    });

    it('no role, wrong password and unknown e-mail: the same 401 invalid-credentials', async () => {
      const noRole = problem(
        await loginOn(hubToken, carl),
        401,
        'invalid-credentials',
      );
      const wrong = problem(
        await h.loginPerson(hubToken, ana.email, carl.account.authProof),
        401,
        'invalid-credentials',
      );
      const unknown = problem(
        await h.loginPerson(
          hubToken,
          'nobody@example.com',
          carl.account.authProof,
        ),
        401,
        'invalid-credentials',
      );
      expect(wrong).toEqual(noRole);
      expect(unknown).toEqual(noRole);
    });

    it('needs a hub token: a user token or none is 401', async () => {
      const body = {
        email: ana.email,
        authProof: ana.account.authProof,
        device: { name: 'Sala' },
      };
      problem(
        await c.http().post('/hub/user-sessions').set(as(ana)).send(body),
        401,
        'invalid-hub-token',
      );
      expect(
        (await c.http().post('/hub/user-sessions').send(body)).status,
      ).toBe(401);
    });

    it('validates the body (device name required, no platform field)', async () => {
      const send = (body: Record<string, unknown>) =>
        c.http().post('/hub/user-sessions').set(c.bearer(hubToken)).send(body);
      problem(
        await send({ email: ana.email, authProof: ana.account.authProof }),
        422,
        'validation-failed',
      );
      problem(
        await send({
          email: ana.email,
          authProof: ana.account.authProof,
          device: { name: 'Sala', platform: 'android' },
        }),
        422,
        'validation-failed',
      );
    });
  });

  describe('the old way is closed', () => {
    it('/auth/login with platform hub is 401 invalid-credentials, even with the right password', async () => {
      const viaHub = problem(
        await c.login(ana.email, ana.account.authProof, {
          name: 'Sala',
          platform: 'hub',
        }),
        401,
        'invalid-credentials',
      );
      const wrong = problem(
        await c.login(ana.email, carl.account.authProof),
        401,
        'invalid-credentials',
      );
      expect(viaHub).toEqual(wrong);
    });

    it('registering with platform hub is 422 device-invalid', async () => {
      const { createClientAccount } =
        await import('../support/client-crypto.js');
      const account = await createClientAccount('another password here');
      problem(
        await c.register(account, 'hubreg@example.com', {
          device: { name: 'Sala', platform: 'hub' },
        }),
        422,
        'device-invalid',
      );
    });
  });

  describe('revocation when the person loses access to the hub', () => {
    it('unlinking the organization revokes the hub sessions of who lost access; phone sessions and the owner stay', async () => {
      const { orgId, hub, hubToken } = await linkedHub('Unlink', [ana]);
      const anaHub = await loggedIn(hubToken, ana);
      const oliviaHub = await loggedIn(hubToken, olivia);
      const anaPhone = await phoneLogin(ana);

      await expectStatus(
        c
          .http()
          .delete(`/hubs/${hub.hubId}/organizations/${orgId}`)
          .set(as(olivia)),
        204,
      );

      problem(await refresh(anaHub.refreshToken), 401, 'invalid-refresh-token');
      expect((await sessionRow(anaHub.sessionId)).revoked_reason).toBe(
        'hub_access_lost',
      );
      await expectStatus(refresh(oliviaHub.refreshToken), 200);
      await expectStatus(refresh(anaPhone.refreshToken), 200);
      // E ela não entra de novo por esse Hub.
      problem(await loginOn(hubToken, ana), 401, 'invalid-credentials');
    });

    it('leaving the organization revokes the hub session; the session on a hub reached through another organization stays', async () => {
      const first = await linkedHub('Leave A', [ana]);
      const second = await linkedHub('Leave B', [ana]);
      const onFirst = await loggedIn(first.hubToken, ana);
      const onSecond = await loggedIn(second.hubToken, ana);
      const anaPhone = await phoneLogin(ana);

      await expectStatus(
        c.http().post(`/organizations/${first.orgId}/leave`).set(as(ana)),
        204,
      );

      problem(
        await refresh(onFirst.refreshToken),
        401,
        'invalid-refresh-token',
      );
      await expectStatus(refresh(onSecond.refreshToken), 200);
      await expectStatus(refresh(anaPhone.refreshToken), 200);
    });

    it('being removed from the organization revokes the hub session', async () => {
      const { orgId, hubToken } = await linkedHub('Removed', [bia]);
      const biaHub = await loggedIn(hubToken, bia);
      await expectStatus(
        c
          .http()
          .delete(`/organizations/${orgId}/members/${bia.userId}`)
          .set(as(olivia)),
        204,
      );
      problem(await refresh(biaHub.refreshToken), 401, 'invalid-refresh-token');
    });

    it('removing an explicit role keeps the session while the person is still an implicit hub_user', async () => {
      const { hub, hubToken } = await linkedHub('Role', [ana]);
      await expectStatus(
        c
          .http()
          .put(`/hubs/${hub.hubId}/roles/${ana.userId}`)
          .set(as(olivia))
          .send({ roleKey: 'hub_operator' }),
        200,
      );
      const anaHub = await loggedIn(hubToken, ana);
      await expectStatus(
        c
          .http()
          .delete(`/hubs/${hub.hubId}/roles/${ana.userId}`)
          .set(as(olivia)),
        204,
      );
      await expectStatus(refresh(anaHub.refreshToken), 200);
      expect((await sessionRow(anaHub.sessionId)).revoked_reason).toBeNull();
    });

    it('a login racing a revocation in flight waits for it and then sees the lost access', async () => {
      // Simula a transação de uma varredura (advisory EXCLUSIVO das sessões do Hub) que tirou o acesso e ainda não
      // confirmou. Sem o advisory compartilhado no login, a checagem leria o vínculo ainda vivo e a sessão nasceria
      // depois da varredura, sem ninguém para revogá-la.
      const zoe = await s.signUpKeyed('zoe@example.com', 'Zoe');
      const { orgId, hub, hubToken } = await linkedHub('Race', [zoe]);
      const res = await withOwnerClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext('hub-person-sessions'), hashtext($1))`,
            [hub.hubId],
          );
          await client.query(
            `UPDATE user_organization SET deleted_at = now()
              WHERE organization_id = $1 AND user_id = $2`,
            [orgId, zoe.userId],
          );
          const pending = loginOn(hubToken, zoe).then((r) => r);
          const deadline = Date.now() + 4_000;
          for (;;) {
            await client.query('SELECT pg_stat_clear_snapshot()');
            const { rows } = await client.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database() AND usename = $1 AND wait_event_type = 'Lock'`,
              [process.env.DB_APP_USERNAME],
            );
            if (rows[0]!.n >= 1) break;
            if (Date.now() > deadline) {
              throw new Error('the login never waited for the sweep lock');
            }
            await new Promise((r) => setTimeout(r, 20));
          }
          await client.query('COMMIT');
          return await pending;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
      problem(res, 401, 'invalid-credentials');
    });

    it('deregistering the hub revokes every session bound to it (owner included), and nothing else', async () => {
      const { hub, hubToken } = await linkedHub('Deregister', [ana]);
      const other = await linkedHub('Other', [ana]);
      const anaHub = await loggedIn(hubToken, ana);
      const oliviaHub = await loggedIn(hubToken, olivia);
      const anaOther = await loggedIn(other.hubToken, ana);
      const oliviaPhone = await phoneLogin(olivia);

      await expectStatus(
        c.http().delete(`/hubs/${hub.hubId}`).set(as(olivia)),
        204,
      );

      problem(await refresh(anaHub.refreshToken), 401, 'invalid-refresh-token');
      problem(
        await refresh(oliviaHub.refreshToken),
        401,
        'invalid-refresh-token',
      );
      expect((await sessionRow(oliviaHub.sessionId)).revoked_reason).toBe(
        'hub_access_lost',
      );
      await expectStatus(refresh(anaOther.refreshToken), 200);
      await expectStatus(refresh(oliviaPhone.refreshToken), 200);
    });
  });
});
