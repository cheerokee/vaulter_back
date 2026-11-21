import type { INestApplication } from '@nestjs/common';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { hubClient } from '../support/hub-client.js';
import type { ClaimedHub } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
} from '../support/identity-client.js';
import { auditRows } from '../support/spaces-db.js';

const rule = (subject: unknown, pattern: string, effect: string) => ({
  subject,
  resource: { kind: 'tool', pattern },
  effect,
});
const ALL = { kind: 'all' };

describe('agent policy of the organization (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const h = hubClient(() => app);
  let olivia: KeyedUser; // org admin, owner of the pc
  let ana: KeyedUser; // member
  let orgId: string;
  let pc: ClaimedHub;

  const put = (token: string, body: unknown, org = orgId) =>
    c
      .http()
      .put(`/organizations/${org}/agent-policy`)
      .set(c.bearer(token))
      .send(body as object);
  const get = (token: string, org = orgId) =>
    c.http().get(`/organizations/${org}/agent-policy`).set(c.bearer(token));
  const hubPolicy = async (hub: ClaimedHub) => {
    const token = await h.authenticate(hub);
    const res = await c
      .http()
      .get('/hub/agent/policy')
      .set('Authorization', `Bearer ${token}`);
    return res;
  };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await c.spaces.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await c.spaces.signUpKeyed('ana@example.com', 'Ana');
    orgId = (await c.spaces.orgWithKit(olivia, 'Agentes')).orgId;
    await c.spaces.joinOrg(olivia, orgId, ana);
    pc = await h.onboard(olivia.token, 'PC da Olivia', { kind: 'pc' });
    await expectStatus(
      c
        .http()
        .post(`/hubs/${pc.hubId}/organizations`)
        .set(c.bearer(olivia.token))
        .send({ organizationId: orgId }),
      201,
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('GET with no policy yet is version 0 with no rules', async () => {
    const res = await expectStatus(get(ana.token), 200);
    expect(res.body).toEqual({ organizationId: orgId, version: 0, rules: [] });
  });

  it('PUT replaces the whole policy with baseVersion and audits organization.agent_policy.changed', async () => {
    const first = [rule(ALL, 'mcp:erp/*', 'allow')];
    const r1 = await expectStatus(
      put(olivia.token, { baseVersion: 0, rules: first }),
      200,
    );
    expect(r1.body).toMatchObject({ organizationId: orgId, version: 1 });
    expect(r1.body.rules).toEqual(first);

    const second = [
      rule(ALL, 'browser:*', 'confirm'),
      rule({ kind: 'user', userId: ana.userId }, 'mcp:erp/*', 'deny'),
    ];
    const r2 = await expectStatus(
      put(olivia.token, { baseVersion: 1, rules: second }),
      200,
    );
    expect(r2.body.version).toBe(2);
    const read = await expectStatus(get(olivia.token), 200);
    expect(read.body.version).toBe(2);
    expect(read.body.rules).toEqual(second);

    const rows = await auditRows(orgId, 'organization.agent_policy');
    expect(rows.map((r) => r.action)).toEqual([
      'organization.agent_policy.changed',
      'organization.agent_policy.changed',
    ]);
    expect(rows.map((r) => r.metadata)).toEqual([
      { version: 1, ruleCount: 1 },
      { version: 2, ruleCount: 2 },
    ]);
    expect(rows.every((r) => r.user_id === olivia.userId)).toBe(true);
  });

  it('a stale baseVersion is 409 agent-policy-version-stale and writes nothing', async () => {
    const before = (await expectStatus(get(olivia.token), 200)).body.version;
    const res = await put(olivia.token, {
      baseVersion: before - 1,
      rules: [],
    });
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/\/agent-policy-version-stale$/);
    expect((await expectStatus(get(olivia.token), 200)).body.version).toBe(
      before,
    );
    // ahead of the current version is stale too
    expect(
      (await put(olivia.token, { baseVersion: before + 1, rules: [] })).status,
    ).toBe(409);
  });

  it('two concurrent PUTs on the same base: exactly one wins, the other is stale', async () => {
    const base = (await expectStatus(get(olivia.token), 200)).body
      .version as number;
    const results = await Promise.all(
      ['a', 'b', 'c'].map((n) =>
        put(olivia.token, {
          baseVersion: base,
          rules: [rule(ALL, `mcp:race/${n}`, 'allow')],
        }),
      ),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409, 409,
    ]);
    expect((await expectStatus(get(olivia.token), 200)).body.version).toBe(
      base + 1,
    );
  });

  it('invalid rules are 422 agent-policy-invalid with invalidRules', async () => {
    const before = (await expectStatus(get(olivia.token), 200)).body.version;
    const res = await put(olivia.token, {
      baseVersion: before,
      rules: [
        rule(ALL, 'mcp:ok/*', 'allow'),
        rule(ALL, 'mcp:bad/*', 'maybe'),
        {
          subject: ALL,
          resource: { kind: 'folder', path: '../x' },
          effect: 'allow',
        },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/\/agent-policy-invalid$/);
    expect(res.body.invalidRules).toEqual([1, 2]);
    expect((await expectStatus(get(olivia.token), 200)).body.version).toBe(
      before,
    );
  });

  it('a policy of 500 long rules fits the body limit; 501 rules are 422', async () => {
    const before = (await expectStatus(get(olivia.token), 200)).body
      .version as number;
    const long = (i: number) =>
      rule(
        { kind: 'user', userId: ana.userId },
        `mcp:server-${i}/${'x'.repeat(150)}*`,
        'confirm',
      );
    const ok = await put(olivia.token, {
      baseVersion: before,
      rules: Array.from({ length: 500 }, (_, i) => long(i)),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.rules).toHaveLength(500);
    const over = await put(olivia.token, {
      baseVersion: before + 1,
      rules: Array.from({ length: 501 }, (_, i) => long(i)),
    });
    expect(over.status).toBe(422);
    expect(over.body.type).toMatch(/\/agent-policy-invalid$/);
  });

  it('PUT needs org.agents.manage; GET works for every member', async () => {
    const denied = await put(ana.token, { baseVersion: 0, rules: [] });
    expect(denied.status).toBe(403);
    expect((await get(ana.token)).status).toBe(200);

    const stranger = await c.spaces.signUpKeyed('rui@example.com', 'Rui');
    expect((await get(stranger.token)).status).toBe(404);
    expect(
      (await put(stranger.token, { baseVersion: 0, rules: [] })).status,
    ).toBe(404);
  });

  it('GET /hub/agent/policy returns, per approved organization, only the all rules and the owner rules', async () => {
    const other = await c.spaces.orgWithKit(olivia, 'Segunda');
    await c.spaces.joinOrg(olivia, other.orgId, ana);
    await expectStatus(
      c
        .http()
        .post(`/hubs/${pc.hubId}/organizations`)
        .set(c.bearer(olivia.token))
        .send({ organizationId: other.orgId }),
      201,
    );
    const current = (await expectStatus(get(olivia.token), 200)).body
      .version as number;
    await expectStatus(
      put(olivia.token, {
        baseVersion: current,
        rules: [
          rule(ALL, 'mcp:erp/*', 'allow'),
          rule({ kind: 'user', userId: olivia.userId }, 'browser:*', 'confirm'),
          rule({ kind: 'user', userId: ana.userId }, 'mcp:erp/*', 'deny'),
        ],
      }),
      200,
    );
    const res = await hubPolicy(pc);
    expect(res.status).toBe(200);
    const byOrg = new Map(
      (
        res.body.items as {
          organizationId: string;
          version: number;
          rules: unknown[];
        }[]
      ).map((i) => [i.organizationId, i]),
    );
    expect(byOrg.size).toBe(3); // personal + the two
    const main = byOrg.get(orgId)!;
    expect(main.version).toBe(current + 1);
    expect(main.rules).toEqual([
      rule(ALL, 'mcp:erp/*', 'allow'),
      rule({ kind: 'user', userId: olivia.userId }, 'browser:*', 'confirm'),
    ]);
    expect(JSON.stringify(res.body)).not.toContain(ana.userId);
    // no policy: version 0 and no rules (deny by default)
    expect(byOrg.get(other.orgId)).toEqual({
      organizationId: other.orgId,
      version: 0,
      rules: [],
    });
  });

  it('an appliance hub gets the not-found of an unknown route; no token is 401', async () => {
    const box = await h.onboard(olivia.token, 'Caixa');
    const res = await hubPolicy(box);
    expect(res.status).toBe(404);
    expect(res.body.detail).toBe('Cannot GET /hub/agent/policy');
    expect((await c.http().get('/hub/agent/policy')).status).toBe(401);
  });

  it('is append-only for the runtime: no UPDATE of rules, no DELETE; only the commit-time version columns', async () => {
    const ds = await adminDataSource();
    const rows = (await ds.query(
      `SELECT c AS column,
              has_column_privilege('app_runtime', 'agent_policies', c, 'UPDATE') AS can_update,
              has_column_privilege('app_runtime', 'agent_policies', c, 'INSERT') AS can_insert
         FROM unnest(ARRAY['rules', 'version', 'organization_id', 'changed_by_user_id', 'sync_version', 'sync_pending']) AS c`,
    )) as { column: string; can_update: boolean; can_insert: boolean }[];
    expect(
      Object.fromEntries(rows.map((r) => [r.column, r.can_update])),
    ).toEqual({
      rules: false,
      version: false,
      organization_id: false,
      changed_by_user_id: false,
      sync_version: true,
      sync_pending: true,
    });
    const [{ del, sel }] = (await ds.query(
      `SELECT has_table_privilege('app_runtime', 'agent_policies', 'DELETE') AS del,
              has_table_privilege('app_runtime', 'agent_policies', 'SELECT') AS sel`,
    )) as [{ del: boolean; sel: boolean }];
    expect({ del, sel }).toEqual({ del: false, sel: true });
  });

  it('a session opened through a hub never rewrites the policy (same 404 as an outsider); reading stays allowed', async () => {
    const before = (await expectStatus(get(olivia.token), 200)).body
      .version as number;
    const login = await expectStatus(
      h.loginPerson(
        await h.authenticate(pc),
        olivia.email,
        olivia.account.authProof,
      ),
      200,
    );
    const hubSession = login.body.session.accessToken as string;
    const refused = await put(hubSession, { baseVersion: before, rules: [] });
    expect(refused.status).toBe(404);
    expect(refused.body.type).toMatch(/\/organization-not-found$/);
    expect((await expectStatus(get(hubSession), 200)).body.version).toBe(
      before,
    );
    expect((await expectStatus(get(olivia.token), 200)).body.version).toBe(
      before,
    );
  });

  it('an organization with a pending link to the pc is not in GET /hub/agent/policy', async () => {
    const carl = await c.spaces.signUpKeyed('carl@example.com', 'Carl');
    const org = await c.spaces.orgWithKit(carl, 'Fechada');
    await c.spaces.joinOrg(carl, org.orgId, olivia);
    await expectStatus(
      c
        .http()
        .patch(`/organizations/${org.orgId}`)
        .set(c.bearer(carl.token))
        .send({ hubLinkPolicy: 'admin_approved' }),
      200,
    );
    const link = await expectStatus(
      c
        .http()
        .post(`/hubs/${pc.hubId}/organizations`)
        .set(c.bearer(olivia.token))
        .send({ organizationId: org.orgId }),
      201,
    );
    expect(link.body.status).toBe('pending');
    const res = await hubPolicy(pc);
    expect(res.status).toBe(200);
    const orgs = (res.body.items as { organizationId: string }[]).map(
      (i) => i.organizationId,
    );
    expect(orgs).not.toContain(org.orgId);
    expect(orgs).toContain(orgId);
  });
});
