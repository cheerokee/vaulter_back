import type { INestApplication } from '@nestjs/common';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
} from '../support/client-crypto.js';
import { identityClient } from '../support/identity-client.js';

const PASSWORD = 'correct horse battery staple';
const MISSING_ID = '0190f3c0-0000-7000-8000-000000000000';

describe('Organizations endpoints (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  let other: ClientAccount;
  const c = identityClient(() => app);

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    account = await createClientAccount(PASSWORD);
    other = await createClientAccount(PASSWORD);
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  it('requires authentication', async () => {
    await c.http().get('/organizations').expect(401);
    await c.http().post('/organizations').send({ name: 'x' }).expect(401);
  });

  it('creates, lists, reads and updates an organization', async () => {
    const ana = await c.signUp(account, 'crud@example.com');
    const created = await c.createOrg(ana.token, 'Acme').expect(201);
    expect(created.body).toMatchObject({
      name: 'Acme',
      isPersonal: false,
      roleKey: 'org_admin',
      recoveryPublicKey: null,
      hubLinkPolicy: expect.any(String),
    });
    expect(created.body.createdAt).toMatch(/Z$/);
    const id = created.body.id as string;

    const list = await c
      .http()
      .get('/organizations')
      .set(c.bearer(ana.token))
      .expect(200);
    expect(list.body.items.map((o: { name: string }) => o.name)).toContain(
      'Acme',
    );
    expect(
      list.body.items.some((o: { isPersonal: boolean }) => o.isPersonal),
    ).toBe(true);
    expect(list.body).toHaveProperty('nextCursor');

    const page = await c
      .http()
      .get('/organizations?limit=1')
      .set(c.bearer(ana.token))
      .expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toEqual(expect.any(String));

    await c
      .http()
      .get(`/organizations/${id}`)
      .set(c.bearer(ana.token))
      .expect(200);

    const patched = await c
      .http()
      .patch(`/organizations/${id}`)
      .set(c.bearer(ana.token))
      .send({ name: 'Acme 2', hubLinkPolicy: 'admin_approved' })
      .expect(200);
    expect(patched.body).toMatchObject({
      name: 'Acme 2',
      hubLinkPolicy: 'admin_approved',
    });

    const empty = await c
      .http()
      .patch(`/organizations/${id}`)
      .set(c.bearer(ana.token))
      .send({})
      .expect(422);
    expect(empty.body.type).toMatch(/validation-failed$/);
    await c
      .http()
      .patch(`/organizations/${id}`)
      .set(c.bearer(ana.token))
      .send({ hubLinkPolicy: 'nope' })
      .expect(422);
    await c
      .http()
      .post('/organizations')
      .set(c.bearer(ana.token))
      .send({})
      .expect(422);
  });

  it('validates path ids as UUID with validation-failed', async () => {
    const ana = await c.signUp(account, 'uuid@example.com');
    const res = await c
      .http()
      .get('/organizations/not-a-uuid')
      .set(c.bearer(ana.token))
      .expect(422);
    expect(res.body.type).toMatch(/validation-failed$/);
    expect(res.body.errors).toEqual([
      { field: 'id', messages: ['id must be a UUID'] },
    ]);
  });

  it('answers 404 to a non-member on every /organizations/:id/* route', async () => {
    const owner = await c.signUp(account, 'owner404@example.com');
    const stranger = await c.signUp(account, 'stranger404@example.com');
    const org = (await c.createOrg(owner.token).expect(201)).body.id as string;
    const inv = (await c.invite(owner.token, org).expect(201)).body.invitation
      .id as string;
    const h = c.bearer(stranger.token);
    const base = `/organizations/${org}`;
    await c.http().get(base).set(h).expect(404);
    await c.http().patch(base).set(h).send({ name: 'x' }).expect(404);
    await c
      .http()
      .put(`${base}/recovery-key`)
      .set(h)
      .send({
        recoveryPublicKey: account.publicKey,
        currentAuthProof: account.authProof,
      })
      .expect(404);
    await c.http().get(`${base}/members`).set(h).expect(404);
    await c
      .http()
      .patch(`${base}/members/${owner.userId}`)
      .set(h)
      .send({ roleKey: 'org_member' })
      .expect(404);
    await c.http().delete(`${base}/members/${owner.userId}`).set(h).expect(404);
    await c.http().post(`${base}/leave`).set(h).expect(404);
    await c
      .http()
      .post(`${base}/invitations`)
      .set(h)
      .send({ roleKey: 'org_member' })
      .expect(404);
    await c.http().get(`${base}/invitations`).set(h).expect(404);
    await c.http().delete(`${base}/invitations/${inv}`).set(h).expect(404);
    await c.http().get(`/organizations/${MISSING_ID}`).set(h).expect(404);
  });

  it('answers 403 to a plain member on admin actions', async () => {
    const owner = await c.signUp(account, 'owner403@example.com');
    const member = await c.signUp(account, 'member403@example.com');
    const org = (await c.createOrg(owner.token).expect(201)).body.id as string;
    const t = (await c.invite(owner.token, org).expect(201)).body
      .token as string;
    await c.acceptInvite(member.token, t).expect(200);
    const h = c.bearer(member.token);
    const base = `/organizations/${org}`;
    await c.http().get(base).set(h).expect(200);
    await c.http().get(`${base}/members`).set(h).expect(200);
    await c.http().patch(base).set(h).send({ name: 'x' }).expect(403);
    await c
      .http()
      .put(`${base}/recovery-key`)
      .set(h)
      .send({
        recoveryPublicKey: other.publicKey,
        currentAuthProof: account.authProof,
      })
      .expect(403);
    await c
      .http()
      .patch(`${base}/members/${owner.userId}`)
      .set(h)
      .send({ roleKey: 'org_member' })
      .expect(403);
    await c.http().delete(`${base}/members/${owner.userId}`).set(h).expect(403);
    await c
      .http()
      .post(`${base}/invitations`)
      .set(h)
      .send({ roleKey: 'org_member' })
      .expect(403);
    await c.http().get(`${base}/invitations`).set(h).expect(403);
    const inv = (await c.invite(owner.token, org).expect(201)).body.invitation
      .id as string;
    await c.http().delete(`${base}/invitations/${inv}`).set(h).expect(403);
  });

  it('serializes concurrent leaves so the last admin survives', async () => {
    const a = await c.signUp(account, 'conc-a@example.com');
    const b = await c.signUp(account, 'conc-b@example.com');
    const org = (await c.createOrg(a.token).expect(201)).body.id as string;
    const t = (await c.invite(a.token, org, 'org_admin').expect(201)).body
      .token as string;
    await c.acceptInvite(b.token, t).expect(200);
    const leave = (by: { token: string }) =>
      c.http().post(`/organizations/${org}/leave`).set(c.bearer(by.token));
    const results = await Promise.all([leave(a), leave(b)]);
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
      204, 422,
    ]);
    const loser = results.find((r) => r.status === 422)!;
    expect(loser.body.type).toMatch(/\/last-admin$/);
    const rows = await (
      await adminDataSource()
    ).query(
      `SELECT count(*)::int AS n FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
       WHERE ra.organization_id = $1 AND r.key = 'org_admin' AND ra.deleted_at IS NULL`,
      [org],
    );
    expect(rows[0].n).toBe(1);
  });

  it('serializes concurrent demotions: the loser lost admin rights (403) and one admin remains', async () => {
    const a = await c.signUp(account, 'conc-c@example.com');
    const b = await c.signUp(account, 'conc-d@example.com');
    const org = (await c.createOrg(a.token).expect(201)).body.id as string;
    const t = (await c.invite(a.token, org, 'org_admin').expect(201)).body
      .token as string;
    await c.acceptInvite(b.token, t).expect(200);
    const demote = (by: { token: string }, target: { userId: string }) =>
      c
        .http()
        .patch(`/organizations/${org}/members/${target.userId}`)
        .set(c.bearer(by.token))
        .send({ roleKey: 'org_member' });
    const results = await Promise.all([demote(a, b), demote(b, a)]);
    const statuses = results.map((r) => r.status).sort((x, y) => x - y);
    expect(statuses[0]).toBe(200);
    expect([403, 422]).toContain(statuses[1]);
    const rows = await (
      await adminDataSource()
    ).query(
      `SELECT count(*)::int AS n FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
       WHERE ra.organization_id = $1 AND r.key = 'org_admin' AND ra.deleted_at IS NULL`,
      [org],
    );
    expect(rows[0].n).toBe(1);
  });

  it('does not let an admin touch another organization through their own (IDOR)', async () => {
    const adminA = await c.signUp(account, 'idor-a@example.com');
    const adminB = await c.signUp(account, 'idor-b@example.com');
    const orgA = (await c.createOrg(adminA.token).expect(201)).body
      .id as string;
    const orgB = (await c.createOrg(adminB.token).expect(201)).body
      .id as string;
    const invB = (await c.invite(adminB.token, orgB).expect(201)).body
      .invitation.id as string;

    await c
      .http()
      .delete(`/organizations/${orgA}/invitations/${invB}`)
      .set(c.bearer(adminA.token))
      .expect(404);
    const pending = await c
      .http()
      .get(`/organizations/${orgB}/invitations`)
      .set(c.bearer(adminB.token))
      .expect(200);
    expect(pending.body.items.map((i: { id: string }) => i.id)).toEqual([invB]);

    await c
      .http()
      .delete(`/organizations/${orgA}/members/${adminB.userId}`)
      .set(c.bearer(adminA.token))
      .expect(404);
    const members = await c
      .http()
      .get(`/organizations/${orgB}/members`)
      .set(c.bearer(adminB.token))
      .expect(200);
    expect(members.body.items.map((m: { userId: string }) => m.userId)).toEqual(
      [adminB.userId],
    );
  });

  it('protects the last admin and the personal owner', async () => {
    const owner = await c.signUp(account, 'last@example.com');
    const org = (await c.createOrg(owner.token).expect(201)).body.id as string;
    const h = c.bearer(owner.token);
    const leave = await c
      .http()
      .post(`/organizations/${org}/leave`)
      .set(h)
      .expect(422);
    expect(leave.body.type).toMatch(/last-admin$/);
    const demote = await c
      .http()
      .patch(`/organizations/${org}/members/${owner.userId}`)
      .set(h)
      .send({ roleKey: 'org_member' })
      .expect(422);
    expect(demote.body.type).toMatch(/last-admin$/);
    await c
      .http()
      .delete(`/organizations/${org}/members/${owner.userId}`)
      .set(h)
      .expect(422);

    // with a second admin the first can leave
    const second = await c.signUp(account, 'last2@example.com');
    const t = (await c.invite(owner.token, org, 'org_admin').expect(201)).body
      .token as string;
    await c.acceptInvite(second.token, t).expect(200);
    await c.http().post(`/organizations/${org}/leave`).set(h).expect(204);
    await c.http().get(`/organizations/${org}`).set(h).expect(404);

    const personal = (
      await c.http().get('/organizations').set(h).expect(200)
    ).body.items.find((o: { isPersonal: boolean }) => o.isPersonal)
      .id as string;
    const pleave = await c
      .http()
      .post(`/organizations/${personal}/leave`)
      .set(h)
      .expect(422);
    expect(pleave.body.type).toMatch(/cannot-leave-personal$/);
    const pdemote = await c
      .http()
      .patch(`/organizations/${personal}/members/${owner.userId}`)
      .set(h)
      .send({ roleKey: 'org_member' })
      .expect(422);
    expect(pdemote.body.type).toMatch(/\/personal-owner-protected$/);
    const premove = await c
      .http()
      .delete(`/organizations/${personal}/members/${owner.userId}`)
      .set(h)
      .expect(422);
    expect(premove.body.type).toMatch(/\/personal-owner-protected$/);
  });

  it('lists members with publicKey and never authHash; changes role and removes', async () => {
    const owner = await c.signUp(account, 'mem-owner@example.com', 'Owner');
    const member = await c.signUp(other, 'mem-member@example.com', 'Mem');
    const org = (await c.createOrg(owner.token).expect(201)).body.id as string;
    const t = (await c.invite(owner.token, org).expect(201)).body
      .token as string;
    await c.acceptInvite(member.token, t).expect(200);

    const res = await c
      .http()
      .get(`/organizations/${org}/members`)
      .set(c.bearer(member.token))
      .expect(200);
    expect(res.body.items).toHaveLength(2);
    const m = res.body.items.find(
      (i: { userId: string }) => i.userId === member.userId,
    );
    expect(m).toMatchObject({
      name: 'Mem',
      email: 'mem-member@example.com',
      publicKey: other.publicKey,
      roleKey: 'org_member',
    });
    expect(m.joinedAt).toMatch(/Z$/);
    expect(JSON.stringify(res.body)).not.toMatch(
      /authHash|auth_hash|encryptedPrivateKey/i,
    );

    const promoted = await c
      .http()
      .patch(`/organizations/${org}/members/${member.userId}`)
      .set(c.bearer(owner.token))
      .send({ roleKey: 'org_admin' })
      .expect(200);
    expect(promoted.body).toEqual({
      userId: member.userId,
      roleKey: 'org_admin',
    });
    await c
      .http()
      .patch(`/organizations/${org}/members/${member.userId}`)
      .set(c.bearer(owner.token))
      .send({ roleKey: 'bogus' })
      .expect(422);
    await c
      .http()
      .delete(`/organizations/${org}/members/${member.userId}`)
      .set(c.bearer(owner.token))
      .expect(204);
    await c
      .http()
      .get(`/organizations/${org}`)
      .set(c.bearer(member.token))
      .expect(404);
  });

  it('replaces the recovery key only with the right current auth proof, auditing it', async () => {
    const owner = await c.signUp(account, 'rk@example.com');
    const org = (await c.createOrg(owner.token).expect(201)).body.id as string;
    const url = `/organizations/${org}/recovery-key`;
    const h = c.bearer(owner.token);
    const noProof = await c
      .http()
      .put(url)
      .set(h)
      .send({ recoveryPublicKey: other.publicKey })
      .expect(422);
    expect(noProof.body.type).toMatch(/validation-failed$/);
    const wrong = await c
      .http()
      .put(url)
      .set(h)
      .send({
        recoveryPublicKey: other.publicKey,
        currentAuthProof: other.authProof,
      })
      .expect(422);
    expect(wrong.body.type).toMatch(/current-auth-proof-invalid$/);

    await c
      .http()
      .put(url)
      .set(h)
      .send({
        recoveryPublicKey: other.publicKey,
        currentAuthProof: account.authProof,
      })
      .expect(204);
    const got = await c.http().get(`/organizations/${org}`).set(h).expect(200);
    expect(got.body.recoveryPublicKey).toBe(other.publicKey);
    await c
      .http()
      .put(url)
      .set(h)
      .send({
        recoveryPublicKey: account.publicKey,
        currentAuthProof: account.authProof,
      })
      .expect(204);

    const rows = await (
      await adminDataSource()
    ).query(
      `SELECT action, metadata FROM audit_logs WHERE organization_id = $1 AND action LIKE 'organization.recovery_key.%' ORDER BY created_at, id`,
      [org],
    );
    expect(rows.map((r: { action: string }) => r.action)).toEqual([
      'organization.recovery_key.registered',
      'organization.recovery_key.replaced',
    ]);
    expect(JSON.stringify(rows)).not.toContain(account.authProof);
  }, 60_000);
});
