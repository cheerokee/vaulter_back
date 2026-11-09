import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { HubTokenService } from '../../src/identity/application/hub-token-service.js';
import { OrganizationAdministration } from '../../src/organizations/application/organization-administration.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { recoveryKitKeypair, sealSpaceKey } from '../support/client-crypto.js';
import { hubsKit } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
} from '../support/identity-client.js';
import { keysDeep } from '../support/json-keys.js';

const DAY = 24 * 60 * 60 * 1000;

// Proteção depois da nomeação pela plataforma (decisão do Jonas, 09/11/2026): por 7 dias ninguém da organização
// registra/troca o kit nem remove membro; o GET da organização mostra a nomeação e a última troca do kit, para o app
// avisar os membros. Pela HTTP real (papel de runtime, RLS valendo) e com a cripto real do cliente.
describe('organization protection after a platform appointment (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  const c = identityClient(() => app);
  const s = c.spaces;
  const k = hubsKit(() => app);
  const h = (u: KeyedUser) => c.bearer(u.token);

  let olivia: KeyedUser; // admin original (conta "perdida")
  let carl: KeyedUser; // nomeado pela plataforma
  let bia: KeyedUser; // membro, promovido a admin pelo Carl
  let dan: KeyedUser; // membro comum
  let eva: KeyedUser; // membro que sai durante a proteção
  let orgId: string;
  let kit: { publicKey: string; privateKey: Uint8Array };

  const putKit = (u: KeyedUser, publicKey: string) =>
    s.setRecoveryKit(u, orgId, publicKey);
  const removeMember = (u: KeyedUser, target: KeyedUser) =>
    c
      .http()
      .delete(`/organizations/${orgId}/members/${target.userId}`)
      .set(h(u));
  const getOrg = async (u: KeyedUser) =>
    (await c.http().get(`/organizations/${orgId}`).set(h(u)).expect(200))
      .body as Record<string, unknown>;
  const appointment = async () =>
    (
      (await admin.query(
        `SELECT platform_appointed_user_id, platform_appointed_at, protected_until
           FROM organizations WHERE id = $1`,
        [orgId],
      )) as {
        platform_appointed_user_id: string | null;
        platform_appointed_at: Date | null;
        protected_until: Date | null;
      }[]
    )[0]!;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    admin = await adminDataSource();
    olivia = await s.signUpKeyed('pr-olivia@example.com', 'Olivia');
    carl = await s.signUpKeyed('pr-carl@example.com', 'Carl');
    bia = await s.signUpKeyed('pr-bia@example.com', 'Bia');
    dan = await s.signUpKeyed('pr-dan@example.com', 'Dan');
    eva = await s.signUpKeyed('pr-eva@example.com', 'Eva');
    ({ orgId, kit } = await s.orgWithKit(olivia, 'Protected Org'));
    for (const u of [bia, dan, eva]) await s.joinOrg(olivia, orgId, u);
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('before any appointment: the kit change by the owner is shown, no appointment', async () => {
    const body = await getOrg(dan);
    expect(body.platformAppointment).toBeNull();
    expect(body.recoveryKeyChangedByUserId).toBe(olivia.userId);
    expect(typeof body.recoveryKeyChangedAt).toBe('string');
  });

  it('the appointee and an admin they promote both get 422 organization-under-protection on the kit and on removing a member', async () => {
    const before = Date.now();
    await expect(
      app
        .get(OrganizationAdministration)
        .appointAdmin(
          orgId,
          carl.userId,
          { kind: 'platform', supportRequestId: newId() },
          new Date(),
        ),
    ).resolves.toEqual({ joined: true });
    const row = await appointment();
    expect(row.platform_appointed_user_id).toBe(carl.userId);
    expect(row.protected_until!.getTime()).toBe(
      row.platform_appointed_at!.getTime() + 7 * DAY,
    );
    expect(row.platform_appointed_at!.getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    const protectedUntil = row.protected_until!.toISOString();

    // the appointee promotes a second account to admin (role changes stay allowed)
    await c
      .http()
      .patch(`/organizations/${orgId}/members/${bia.userId}`)
      .set(h(carl))
      .send({ roleKey: 'org_admin' })
      .expect(200);

    const kit2 = await recoveryKitKeypair();
    // everyone with the permission is blocked, the original admin too
    for (const who of [carl, bia, olivia]) {
      const kitRes = await putKit(who, kit2.publicKey).expect(422);
      expect(kitRes.headers['content-type']).toMatch(/problem\+json/);
      expect(kitRes.body.type).toMatch(/\/organization-under-protection$/);
      expect(kitRes.body.protectedUntil).toBe(protectedUntil);
      const rm = await removeMember(who, dan).expect(422);
      expect(rm.body.type).toMatch(/\/organization-under-protection$/);
      expect(rm.body.protectedUntil).toBe(protectedUntil);
    }
    // a plain member still gets the permission error first
    await removeMember(dan, olivia).expect(403);
    // nothing changed: the kit is the owner's, dan is still a member
    const body = await getOrg(dan);
    expect(body.recoveryPublicKey).toBe(kit.publicKey);
    expect(body.recoveryKeyChangedByUserId).toBe(olivia.userId);
    const members = await c
      .http()
      .get(`/organizations/${orgId}/members?limit=100`)
      .set(h(carl))
      .expect(200);
    expect(
      (members.body.items as { userId: string }[]).map((m) => m.userId),
    ).toContain(dan.userId);
  });

  it('GET /organizations/:id shows the appointment to every member', async () => {
    const row = await appointment();
    for (const u of [dan, carl, olivia]) {
      expect((await getOrg(u)).platformAppointment).toEqual({
        appointedUserId: carl.userId,
        appointedAt: row.platform_appointed_at!.toISOString(),
        protectedUntil: row.protected_until!.toISOString(),
      });
    }
    // the list of my organizations carries it too
    const mine = await c
      .http()
      .get('/organizations?limit=100')
      .set(h(dan))
      .expect(200);
    const item = (mine.body.items as Record<string, unknown>[]).find(
      (o) => o.id === orgId,
    );
    expect(item?.platformAppointment).toMatchObject({
      appointedUserId: carl.userId,
    });
  });

  it('during protection: leaving the organization and reopening an orphan space with the CURRENT kit still work', async () => {
    await c
      .http()
      .post(`/organizations/${orgId}/leave`)
      .set(h(eva))
      .expect(204);

    // olivia creates a space and leaves it: nobody holds the key
    const created = await s.create(olivia, orgId, kit.publicKey, 'Arquivo');
    expect(created.res.status).toBe(201);
    await c
      .http()
      .post(`/spaces/${created.spaceId}/leave`)
      .set(h(olivia))
      .expect(204);

    // the appointee reopens it through the current kit (spaces module untouched)
    const keys = await s.openRecoveryCopies(carl, created.spaceId, kit);
    expect(keys).toEqual([created.key]);
    await expectStatus(
      c
        .http()
        .post(`/spaces/${created.spaceId}/recover`)
        .set(h(carl))
        .send({
          grants: [
            {
              version: 1,
              wrappedKey: await sealSpaceKey(keys[0]!, carl.account.publicKey),
            },
          ],
          currentAuthProof: carl.account.authProof,
        }),
      200,
    );
    const opened = await s.openKeys(carl, created.spaceId);
    expect(opened.currentVersion).toBe(1);
    expect(opened.keys.get(1)).toEqual(created.key);
  });

  it('after the window: the kit change and the removal work; the view shows who changed the kit and when', async () => {
    await admin.query(
      `UPDATE organizations
          SET platform_appointed_at = platform_appointed_at - interval '8 days',
              protected_until = protected_until - interval '8 days'
        WHERE id = $1`,
      [orgId],
    );
    const kit3 = await recoveryKitKeypair();
    const before = Date.now();
    await putKit(carl, kit3.publicKey).expect(204);
    await removeMember(bia, dan).expect(204);

    const body = await getOrg(olivia);
    expect(body.recoveryPublicKey).toBe(kit3.publicKey);
    expect(body.recoveryKeyChangedByUserId).toBe(carl.userId);
    const changedAt = Date.parse(body.recoveryKeyChangedAt as string);
    expect(changedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(changedAt).toBeLessThanOrEqual(Date.now() + 1000);
    // still shown after the window (warning history), until protectedUntil + 30 days
    expect(body.platformAppointment).toMatchObject({
      appointedUserId: carl.userId,
    });

    await admin.query(
      `UPDATE organizations
          SET platform_appointed_at = platform_appointed_at - interval '30 days',
              protected_until = protected_until - interval '30 days'
        WHERE id = $1`,
      [orgId],
    );
    expect((await getOrg(olivia)).platformAppointment).toBeNull();
  });

  it('re-appointing an existing admin does not restart the window; a new appointment does', async () => {
    const old = await appointment();
    await app
      .get(OrganizationAdministration)
      .appointAdmin(
        orgId,
        carl.userId,
        { kind: 'platform', supportRequestId: newId() },
        new Date(),
      );
    expect(await appointment()).toEqual(old);

    const fred = await s.signUpKeyed('pr-fred@example.com', 'Fred');
    await app
      .get(OrganizationAdministration)
      .appointAdmin(
        orgId,
        fred.userId,
        { kind: 'platform', supportRequestId: newId() },
        new Date(),
      );
    const fresh = await appointment();
    expect(fresh.platform_appointed_user_id).toBe(fred.userId);
    expect(fresh.protected_until!.getTime()).toBeGreaterThan(Date.now());
    const kit4 = await recoveryKitKeypair();
    const res = await putKit(carl, kit4.publicKey).expect(422);
    expect(res.body.protectedUntil).toBe(fresh.protected_until!.toISOString());
  });

  it('the hub sync organization item carries none of the new fields', async () => {
    const hub = await k.claim(olivia, 'Sala');
    await k.link(olivia, hub.hubId, orgId);
    const token = (await app.get(HubTokenService).issue(hub.hubId)).token;
    const res = await c
      .http()
      .get('/hub/sync')
      .query({ since: 0, limit: 500 })
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
    const orgItems = (
      res.body.items as { type: string; data: Record<string, unknown> }[]
    ).filter((i) => i.type === 'organization');
    const ours = orgItems.find((i) => i.data.id === orgId);
    expect(ours).toBeDefined();
    for (const item of orgItems) {
      expect(
        keysDeep(item.data).filter((key) =>
          /recovery|platform|appoint|protect/i.test(key),
        ),
      ).toEqual([]);
    }
    expect(JSON.stringify(res.body)).not.toMatch(
      /protectedUntil|protected_until|platformAppoint|platform_appointed|recoveryKeyChanged|recovery_key_changed/,
    );
  });
});
