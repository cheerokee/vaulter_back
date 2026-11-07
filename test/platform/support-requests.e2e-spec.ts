import type { INestApplication } from '@nestjs/common';
import {
  createTestApp,
  adminDataSource,
  resetDatabase,
} from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
} from '../support/client-crypto.js';
import { hubClient } from '../support/hub-client.js';
import { hubDeregistered, hubsKit } from '../support/hubs-kit.js';
import { identityClient } from '../support/identity-client.js';
import {
  grantRoleInDb,
  platformClient,
  raceUnderStaffLock,
  requestAuditRows,
} from '../support/platform-kit.js';
import { auditRows } from '../support/spaces-db.js';

const PASSWORD = 'correct horse battery staple';
const MISSING_ID = '0190f3c0-0000-7000-8000-000000000000';

// Pedidos de suporte (spec de papéis da plataforma §4.3/§4.4) pela HTTP, com o login de runtime (RLS valendo) e as
// operações reais de hubs/organizations.
describe('Platform support requests (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  const c = identityClient(() => app);
  const p = platformClient(() => app);
  const hk = hubsKit(() => app);
  const hc = hubClient(() => app);

  type User = { userId: string; token: string; email: string };
  let admin: User;
  let support: User;
  let finance: User;
  let owner: User;
  let proof: string;

  beforeAll(async () => {
    app = await createTestApp();
    account = await createClientAccount(PASSWORD);
    proof = account.authProof;
  }, 60_000);
  beforeEach(async () => {
    await resetDatabase();
    admin = await c.signUp(account, 'admin@example.com', 'Admin');
    support = await c.signUp(account, 'support@example.com', 'Sup');
    finance = await c.signUp(account, 'finance@example.com', 'Fin');
    owner = await c.signUp(account, 'owner@example.com', 'Owner');
    await grantRoleInDb(admin.userId, 'platform_admin');
    await grantRoleInDb(support.userId, 'platform_support');
    await grantRoleInDb(finance.userId, 'platform_finance');
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  const deregisterBody = (hubId: string) => ({
    type: 'hub_force_deregister',
    hubId,
    reason: 'Owner lost access to the account',
    evidence: 'Invoice 4567, ID checked, external check #123',
    currentAuthProof: proof,
  });
  const appointBody = (organizationId: string, userId: string) => ({
    type: 'org_appoint_admin',
    organizationId,
    userId,
    reason: 'The only admin is unreachable',
    evidence: 'Contract 12, CNPJ checked',
    currentAuthProof: proof,
  });

  async function businessOrg(): Promise<string> {
    const res = await c.createOrg(owner.token, 'Acme').expect(201);
    return res.body.id as string;
  }

  const orgRole = async (orgId: string, userId: string) => {
    const rows: { key: string }[] = await (
      await adminDataSource()
    ).query(
      `SELECT r.key FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.user_id = $2 AND ra.scope_type = 'organization'
          AND ra.deleted_at IS NULL`,
      [orgId, userId],
    );
    return rows[0]?.key ?? null;
  };

  it('support asks for a forced deregistration: pending, the hub keeps working', async () => {
    const hub = await hk.claim(owner);
    const res = await p
      .createRequest(support.token, deregisterBody(hub.hubId))
      .expect(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      type: 'hub_force_deregister',
      status: 'pending',
      hubId: hub.hubId,
      organizationId: null,
      userId: null,
      reason: 'Owner lost access to the account',
      evidence: 'Invoice 4567, ID checked, external check #123',
      requestedByUserId: support.userId,
      decidedByUserId: null,
      decidedAt: null,
      decisionNote: null,
      executedAt: null,
      failureType: null,
      expiresAt: expect.stringMatching(/Z$/),
      createdAt: expect.stringMatching(/Z$/),
    });
    const ttl = Date.parse(res.body.expiresAt) - Date.parse(res.body.createdAt);
    expect(Math.abs(ttl - 7 * 86_400_000)).toBeLessThan(5_000);
    expect(await hubDeregistered(hub.hubId)).toBe(false);
    const token = await hc.authenticate(hub);
    await hc.sync(token).expect(200);
    expect(await requestAuditRows(res.body.id)).toEqual([
      expect.objectContaining({
        user_id: support.userId,
        action: 'platform.request.created',
        result: 'success',
        target_hub_id: hub.hubId,
      }),
    ]);
  });

  it('the requester never approves their own request (self-approval), even after becoming admin', async () => {
    const hub = await hk.claim(owner);
    const created = await p
      .createRequest(support.token, deregisterBody(hub.hubId))
      .expect(201);
    // Support has no platform.support.approve: the route is hidden.
    await p.approveRequest(support.token, created.body.id, proof).expect(404);
    await grantRoleInDb(support.userId, 'platform_admin');
    const res = await p
      .approveRequest(support.token, created.body.id, proof)
      .expect(422);
    expect(res.body.type).toMatch(/\/self-approval$/);
    expect(await hubDeregistered(hub.hubId)).toBe(false);
  });

  it('an admin approves: executed, hub deregistered (its token is refused), audited by the platform', async () => {
    const hub = await hk.claim(owner);
    const hubToken = await hc.authenticate(hub);
    const created = await p
      .createRequest(support.token, deregisterBody(hub.hubId))
      .expect(201);
    const res = await p
      .approveRequest(admin.token, created.body.id, proof)
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'executed',
      decidedByUserId: admin.userId,
      decidedAt: expect.stringMatching(/Z$/),
      executedAt: expect.stringMatching(/Z$/),
      failureType: null,
    });
    expect(await hubDeregistered(hub.hubId)).toBe(true);
    await hc.sync(hubToken).expect(401);
    expect(
      (await requestAuditRows(created.body.id)).map((r) => [
        r.action,
        r.user_id,
        r.result,
      ]),
    ).toEqual([
      ['platform.request.created', support.userId, 'success'],
      ['platform.request.approved', admin.userId, 'success'],
      ['platform.request.executed', admin.userId, 'success'],
    ]);
    // The hubs trail marks the platform and the request, without the staff account.
    const personal: { id: string }[] = await (
      await adminDataSource()
    ).query(`SELECT id FROM organizations WHERE personal_owner_user_id = $1`, [
      owner.userId,
    ]);
    const dereg = await auditRows(personal[0]!.id, 'hub.deregistered');
    expect(dereg).toEqual([
      expect.objectContaining({
        user_id: null,
        metadata: expect.objectContaining({
          actor: 'platform',
          supportRequestId: created.body.id,
          hubId: hub.hubId,
        }),
      }),
    ]);
  });

  it('an admin asks directly: executed in the POST response', async () => {
    const hub = await hk.claim(owner);
    const res = await p
      .createRequest(admin.token, deregisterBody(hub.hubId))
      .expect(201);
    expect(res.body).toMatchObject({
      status: 'executed',
      requestedByUserId: admin.userId,
      decidedByUserId: admin.userId,
    });
    expect(await hubDeregistered(hub.hubId)).toBe(true);
    expect((await requestAuditRows(res.body.id)).map((r) => r.action)).toEqual([
      'platform.request.created',
      'platform.request.approved',
      'platform.request.executed',
    ]);
  });

  it('a hub already deregistered: the request ends failed with hub-not-found (201 and 200)', async () => {
    const hub = await hk.claim(owner);
    const pending = await p
      .createRequest(support.token, deregisterBody(hub.hubId))
      .expect(201);
    await hk.deregister(owner, hub.hubId);

    const direct = await p
      .createRequest(admin.token, deregisterBody(hub.hubId))
      .expect(201);
    expect(direct.body).toMatchObject({
      status: 'failed',
      failureType: 'hub-not-found',
      executedAt: null,
    });
    const approved = await p
      .approveRequest(admin.token, pending.body.id, proof)
      .expect(200);
    expect(approved.body).toMatchObject({
      status: 'failed',
      failureType: 'hub-not-found',
    });
    expect((await requestAuditRows(pending.body.id)).at(-1)).toMatchObject({
      action: 'platform.request.failed',
      result: 'error',
      metadata: { type: 'hub_force_deregister', failureType: 'hub-not-found' },
    });
  });

  it('appointment: support asks, admin approves; the target becomes org_admin and the org trail hides the staff', async () => {
    const orgId = await businessOrg();
    const carl = await c.signUp(account, 'carl@example.com', 'Carl');
    const created = await p
      .createRequest(support.token, appointBody(orgId, carl.userId))
      .expect(201);
    expect(created.body).toMatchObject({
      status: 'pending',
      hubId: null,
      organizationId: orgId,
      userId: carl.userId,
    });
    expect(await orgRole(orgId, carl.userId)).toBeNull();
    await p.approveRequest(admin.token, created.body.id, proof).expect(200);
    expect(await orgRole(orgId, carl.userId)).toBe('org_admin');
    const rows = await auditRows(orgId, 'member.');
    expect(rows.map((r) => r.action)).toEqual([
      'member.joined',
      'member.role_changed',
    ]);
    for (const row of rows) {
      expect(row.user_id).toBeNull();
      expect(row.metadata).toMatchObject({
        actor: 'platform',
        supportRequestId: created.body.id,
        targetUserId: carl.userId,
      });
    }
    expect((await requestAuditRows(created.body.id)).at(-1)).toMatchObject({
      action: 'platform.request.executed',
      target_organization_id: orgId,
      target_user_id: carl.userId,
    });
  });

  it('a staff target is refused at creation (422 staff-cannot-be-appointed), the requester included', async () => {
    const orgId = await businessOrg();
    for (const target of [finance, support, admin]) {
      const res = await p
        .createRequest(support.token, appointBody(orgId, target.userId))
        .expect(422);
      expect(res.body.type).toMatch(/\/staff-cannot-be-appointed$/);
    }
  });

  it('a target that becomes staff after the request: approval ends failed staff-cannot-be-appointed', async () => {
    const orgId = await businessOrg();
    const carl = await c.signUp(account, 'carl@example.com', 'Carl');
    const created = await p
      .createRequest(support.token, appointBody(orgId, carl.userId))
      .expect(201);
    await grantRoleInDb(carl.userId, 'platform_finance');
    const res = await p
      .approveRequest(admin.token, created.body.id, proof)
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'failed',
      failureType: 'staff-cannot-be-appointed',
    });
    expect(await orgRole(orgId, carl.userId)).toBeNull();
  });

  it('a personal organization: failed personal-organization-protected, nothing changes', async () => {
    const personal: { id: string }[] = await (
      await adminDataSource()
    ).query(`SELECT id FROM organizations WHERE personal_owner_user_id = $1`, [
      owner.userId,
    ]);
    const carl = await c.signUp(account, 'carl@example.com', 'Carl');
    const res = await p
      .createRequest(admin.token, appointBody(personal[0]!.id, carl.userId))
      .expect(201);
    expect(res.body).toMatchObject({
      status: 'failed',
      failureType: 'personal-organization-protected',
    });
    expect(await orgRole(personal[0]!.id, carl.userId)).toBeNull();
  });

  it('unknown targets are 404 at creation; an invalid type × target pair is 422', async () => {
    const orgId = await businessOrg();
    const hub = await p
      .createRequest(support.token, deregisterBody(MISSING_ID))
      .expect(404);
    expect(hub.body.type).toMatch(/\/hub-not-found$/);
    const user = await p
      .createRequest(support.token, appointBody(orgId, MISSING_ID))
      .expect(404);
    expect(user.body.type).toMatch(/\/user-not-found$/);
    const org = await p
      .createRequest(support.token, appointBody(MISSING_ID, owner.userId))
      .expect(404);
    expect(org.body.type).toMatch(/\/organization-not-found$/);
    const mixed = await p
      .createRequest(support.token, {
        ...deregisterBody(MISSING_ID),
        organizationId: orgId,
      })
      .expect(422);
    expect(mixed.body.type).toMatch(/\/support-request-target-invalid$/);
    await p
      .createRequest(support.token, {
        ...deregisterBody(MISSING_ID),
        reason: '',
      })
      .expect(422);
    await p
      .createRequest(support.token, {
        ...deregisterBody(MISSING_ID),
        evidence: 'x'.repeat(2001),
      })
      .expect(422);
  });

  it('a request past 7 days: approval is 422 support-request-expired and the state stays expired', async () => {
    const hub = await hk.claim(owner);
    const created = await p
      .createRequest(support.token, deregisterBody(hub.hubId))
      .expect(201);
    await (
      await adminDataSource()
    ).query(
      `UPDATE platform_support_requests
          SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day'
        WHERE id = $1`,
      [created.body.id],
    );
    const res = await p
      .approveRequest(admin.token, created.body.id, proof)
      .expect(422);
    expect(res.body.type).toMatch(/\/support-request-expired$/);
    const read = await p.getRequest(admin.token, created.body.id).expect(200);
    expect(read.body.status).toBe('expired');
    expect(await hubDeregistered(hub.hubId)).toBe(false);
    expect(
      (await requestAuditRows(created.body.id)).map((r) => [
        r.action,
        r.user_id,
      ]),
    ).toEqual([
      ['platform.request.created', support.userId],
      ['platform.request.expired', null],
    ]);
    // A decision on an expired request keeps answering expired.
    await p
      .rejectRequest(admin.token, created.body.id, 'late', proof)
      .expect(422);
  });

  it('a pending request past its deadline is expired on read (list and get)', async () => {
    const hub = await hk.claim(owner);
    const created = await p
      .createRequest(support.token, deregisterBody(hub.hubId))
      .expect(201);
    await (
      await adminDataSource()
    ).query(
      `UPDATE platform_support_requests SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [created.body.id],
    );
    const list = await p.listRequests(support.token).expect(200);
    expect(list.body.items.map((r: { status: string }) => r.status)).toEqual([
      'expired',
    ]);
    expect(
      (await requestAuditRows(created.body.id)).map((r) => r.action),
    ).toEqual(['platform.request.created', 'platform.request.expired']);
  });

  it('support lists and reads only their own requests; admin sees all, with a status filter and a cursor', async () => {
    const support2 = await c.signUp(account, 'support2@example.com', 'Sup2');
    await grantRoleInDb(support2.userId, 'platform_support');
    const h1 = await hk.claim(owner, 'One');
    const h2 = await hk.claim(owner, 'Two');
    const mine = await p
      .createRequest(support.token, deregisterBody(h1.hubId))
      .expect(201);
    const theirs = await p
      .createRequest(support2.token, deregisterBody(h2.hubId))
      .expect(201);
    await p
      .rejectRequest(
        admin.token,
        theirs.body.id,
        'Evidence does not match',
        proof,
      )
      .expect(200);

    const own = await p.listRequests(support.token).expect(200);
    expect(own.body).toEqual({
      items: [expect.objectContaining({ id: mine.body.id })],
      nextCursor: null,
    });
    await p.getRequest(support.token, mine.body.id).expect(200);
    const other = await p.getRequest(support.token, theirs.body.id).expect(404);
    expect(other.body.type).toMatch(/\/support-request-not-found$/);

    const all = await p.listRequests(admin.token, { limit: 1 }).expect(200);
    expect(all.body.items).toHaveLength(1);
    expect(all.body.nextCursor).toEqual(expect.any(String));
    const next = await p
      .listRequests(admin.token, { limit: 1, cursor: all.body.nextCursor })
      .expect(200);
    expect(next.body.nextCursor).toBeNull();
    // Newest first.
    expect([all.body.items[0].id, next.body.items[0].id]).toEqual([
      theirs.body.id,
      mine.body.id,
    ]);
    const rejected = await p
      .listRequests(admin.token, { status: 'rejected' })
      .expect(200);
    expect(rejected.body.items.map((r: { id: string }) => r.id)).toEqual([
      theirs.body.id,
    ]);
    await p.listRequests(admin.token, { status: 'weird' }).expect(422);
    await p.getRequest(admin.token, MISSING_ID).expect(404);
  });

  it('a rejection with a note: rejected, nothing changes; decisions need the reauthentication', async () => {
    const hub = await hk.claim(owner);
    const created = await p
      .createRequest(support.token, deregisterBody(hub.hubId))
      .expect(201);
    await p.rejectRequest(admin.token, created.body.id, '', proof).expect(422);
    const badProof = await p
      .approveRequest(admin.token, created.body.id, 'A'.repeat(43))
      .expect(422);
    expect(badProof.body.type).toMatch(/\/current-auth-proof-invalid$/);
    const res = await p
      .rejectRequest(
        admin.token,
        created.body.id,
        'Evidence does not match',
        proof,
      )
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'rejected',
      decidedByUserId: admin.userId,
      decisionNote: 'Evidence does not match',
      executedAt: null,
    });
    expect(await hubDeregistered(hub.hubId)).toBe(false);
    const again = await p
      .approveRequest(admin.token, created.body.id, proof)
      .expect(409);
    expect(again.body.type).toMatch(/\/support-request-not-pending$/);
    expect(
      (await requestAuditRows(created.body.id)).map((r) => r.action),
    ).toEqual(['platform.request.created', 'platform.request.rejected']);
  });

  it('finance (no permission) and customers get 404 on every support route', async () => {
    const hub = await hk.claim(owner);
    const created = await p
      .createRequest(support.token, deregisterBody(hub.hubId))
      .expect(201);
    const id = created.body.id as string;
    for (const who of [finance, owner]) {
      await p.createRequest(who.token, deregisterBody(hub.hubId)).expect(404);
      await p.listRequests(who.token).expect(404);
      await p.getRequest(who.token, id).expect(404);
      await p.approveRequest(who.token, id, proof).expect(404);
      await p.rejectRequest(who.token, id, 'no', proof).expect(404);
    }
    // Support cannot reject either (needs platform.support.approve).
    await p.rejectRequest(support.token, id, 'no', proof).expect(404);
  });

  const auditIdOf = async (action: string, supportRequestId?: string) => {
    const rows: { id: string }[] = await (
      await adminDataSource()
    ).query(
      `SELECT id FROM platform_audit_logs
        WHERE action = $1 AND ($2::uuid IS NULL OR support_request_id = $2::uuid) ORDER BY id`,
      [action, supportRequestId ?? null],
    );
    return rows.map((r) => r.id);
  };

  it('two admins approve the same request concurrently: one 200, one 409, executed once', async () => {
    const admin2 = await c.signUp(account, 'admin2@example.com', 'Admin 2');
    await grantRoleInDb(admin2.userId, 'platform_admin');
    const hub = await hk.claim(owner);
    const created = await p
      .createRequest(support.token, deregisterBody(hub.hubId))
      .expect(201);
    const id = created.body.id as string;

    // Both decisions wait on lockAdminsForShare (held FOR UPDATE here), then serialize on the request row.
    const results = await raceUnderStaffLock(
      () =>
        [admin, admin2].map((u) =>
          Promise.resolve(p.approveRequest(u.token, id, proof)),
        ),
      2,
    );
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
      200, 409,
    ]);
    expect(results.find((r) => r.status === 409)!.body.type).toMatch(
      /\/support-request-not-pending$/,
    );
    expect(await auditIdOf('platform.request.executed', id)).toHaveLength(1);
    expect(await hubDeregistered(hub.hubId)).toBe(true);
  });

  it('a revocation racing a decision: the two serialize (approved before the revoke, or 404 after it)', async () => {
    const admin2 = await c.signUp(account, 'admin2@example.com', 'Admin 2');
    await grantRoleInDb(admin2.userId, 'platform_admin');
    const hub = await hk.claim(owner);
    const created = await p
      .createRequest(support.token, deregisterBody(hub.hubId))
      .expect(201);
    const id = created.body.id as string;

    // The revoke waits on lockAdmins (FOR UPDATE), the approval on lockAdminsForShare: neither runs on a stale role.
    const [approval, revocation] = await raceUnderStaffLock(
      () => [
        Promise.resolve(p.approveRequest(admin.token, id, proof)),
        Promise.resolve(
          p.revoke(admin2.token, admin.userId, 'platform_admin', proof),
        ),
      ],
      2,
    );
    expect(revocation!.status).toBe(204);
    const [revoked] = await auditIdOf('platform.role.revoked');
    const executed = await auditIdOf('platform.request.executed', id);
    if (approval!.status === 200) {
      // Approved first: executed before the revocation was even read.
      expect(executed).toHaveLength(1);
      expect(executed[0]! < revoked!).toBe(true);
      expect(await hubDeregistered(hub.hubId)).toBe(true);
    } else {
      // Revoked first: the decision re-checks the permission under the lock and stops.
      expect(approval!.status).toBe(404);
      expect(executed).toEqual([]);
      const after = await p.getRequest(admin2.token, id).expect(200);
      expect(after.body.status).toBe('pending');
      expect(await hubDeregistered(hub.hubId)).toBe(false);
    }
  });
});
