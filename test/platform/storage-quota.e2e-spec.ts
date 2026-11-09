import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
} from '../support/client-crypto.js';
import { identityClient, type KeyedUser } from '../support/identity-client.js';
import { grantRoleInDb, platformAuditRows } from '../support/platform-kit.js';
import { auditRows } from '../support/spaces-db.js';

const PASSWORD = 'correct horse battery staple';
const GIB = 1_073_741_824;
const MISSING_ID = '0190f3c0-0000-7000-8000-000000000000';

describe('PUT /platform/organizations/:orgId/storage-quota (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  const c = identityClient(() => app);
  const put = (token: string, orgId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .put(`/platform/organizations/${orgId}/storage-quota`)
      .set({ Authorization: `Bearer ${token}` })
      .send(body);

  let finance: { userId: string; token: string };
  let support: { userId: string; token: string };
  let admin: { userId: string; token: string };
  let owner: KeyedUser;
  let orgId: string;
  let kit: { publicKey: string };

  const body = (quotaBytes: number) => ({
    quotaBytes,
    reason: 'plan upgrade, invoice 123',
    currentAuthProof: account.authProof,
  });
  const orgView = async () =>
    (
      await request(app.getHttpServer())
        .get(`/organizations/${orgId}`)
        .set({ Authorization: `Bearer ${owner.token}` })
        .expect(200)
    ).body;

  beforeAll(async () => {
    app = await createTestApp();
    account = await createClientAccount(PASSWORD);
  }, 60_000);
  beforeEach(async () => {
    await resetDatabase();
    finance = await c.signUp(account, 'finance@example.com', 'Fin');
    support = await c.signUp(account, 'support@example.com', 'Sup');
    admin = await c.signUp(account, 'admin@example.com', 'Adm');
    await grantRoleInDb(finance.userId, 'platform_finance');
    await grantRoleInDb(support.userId, 'platform_support');
    await grantRoleInDb(admin.userId, 'platform_admin');
    owner = await c.spaces.signUpKeyed('owner@example.com', 'Owner');
    ({ orgId, kit } = await c.spaces.orgWithKit(owner));
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  it('finance sets the quota: 200, the organization shows it, both trails record it', async () => {
    const res = await put(finance.token, orgId, body(100 * GIB)).expect(200);
    expect(res.body).toEqual({
      organizationId: orgId,
      fromBytes: 50 * GIB,
      toBytes: 100 * GIB,
    });
    expect((await orgView()).storage.quotaBytes).toBe(100 * GIB);

    const platform = (await platformAuditRows()).filter(
      (r) => r.action === 'platform.organization.storage_quota_changed',
    );
    expect(platform).toHaveLength(1);
    expect(platform[0]).toMatchObject({
      user_id: finance.userId,
      result: 'success',
      metadata: {
        from: 50 * GIB,
        to: 100 * GIB,
        reason: 'plan upgrade, invoice 123',
      },
    });
    const rows = await auditRows(orgId, 'organization.storage_quota_changed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: null,
      metadata: { actor: 'platform', fromBytes: 50 * GIB, toBytes: 100 * GIB },
    });
    expect(rows[0]!.metadata).not.toHaveProperty('supportRequestId');
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain(finance.userId);
  });

  it('an admin may too; support and a plain user get 404', async () => {
    await put(admin.token, orgId, body(60 * GIB)).expect(200);
    await put(support.token, orgId, body(70 * GIB)).expect(404);
    await put(owner.token, orgId, body(70 * GIB)).expect(404);
    expect((await orgView()).storage.quotaBytes).toBe(60 * GIB);
  });

  it('below the reserved sum: 422 storage-quota-below-reserved, nothing changes', async () => {
    const { res } = await c.spaces.create(owner, orgId, kit.publicKey);
    expect(res.status).toBe(201);
    const view = await orgView();
    expect(view.storage.reservedBytes).toBe(10 * GIB);
    const bad = await put(finance.token, orgId, body(5 * GIB)).expect(422);
    expect(bad.body.type).toMatch(/storage-quota-below-reserved$/);
    expect(bad.body.reservedBytes).toBe(10 * GIB);
    expect((await orgView()).storage.quotaBytes).toBe(50 * GIB);
    // exactly the reserved sum is fine
    await put(finance.token, orgId, body(10 * GIB)).expect(200);
  });

  it('unknown organization 404; malformed id 422; invalid body 422; wrong proof 422', async () => {
    await put(finance.token, MISSING_ID, body(GIB)).expect(404);
    await put(finance.token, 'nope', body(GIB)).expect(422);
    await put(finance.token, orgId, body(0)).expect(422);
    await put(finance.token, orgId, { ...body(GIB), reason: '' }).expect(422);
    await put(finance.token, orgId, {
      ...body(GIB),
      currentAuthProof: 'AAAA',
    }).expect(422);
    const ds = await adminDataSource();
    const [{ q }] = await ds.query(
      `SELECT storage_quota_bytes::bigint AS q FROM organizations WHERE id = $1`,
      [orgId],
    );
    expect(Number(q)).toBe(50 * GIB);
  });
});
