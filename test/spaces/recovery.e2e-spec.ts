import type { INestApplication } from '@nestjs/common';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  generateSpaceKey,
  openSpaceKey,
  recoveryKitKeypair,
  sealSpaceKey,
} from '../support/client-crypto.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
  recipientOf,
} from '../support/identity-client.js';
import {
  activeSpaceMembers,
  auditRows,
  spaceRow,
} from '../support/spaces-db.js';

type Kit = { publicKey: string; privateKey: Uint8Array };

describe('Space recovery kit, orphan spaces and managers (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = (u: KeyedUser) => c.bearer(u.token);

  let owner: KeyedUser;
  let admin2: KeyedUser;
  let ana: KeyedUser;
  let bia: KeyedUser;

  const setup = async (name: string) => {
    const { orgId, kit } = await s.orgWithKit(owner, name);
    await s.joinOrg(owner, orgId, admin2, 'org_admin');
    for (const u of [ana, bia]) await s.joinOrg(owner, orgId, u);
    const space = await s.create(owner, orgId, kit.publicKey, name);
    expect(space.res.status).toBe(201);
    return { orgId, kit, spaceId: space.spaceId, keys: [space.key] };
  };

  /** What the kit holder does: opens the kit copy of every version (read from the backup) with the kit. */
  const openWithKit = async (spaceId: string, kit: Kit) => {
    const rows: { version: number; recovery_wrapped_key: string }[] = await (
      await adminDataSource()
    ).query(
      `SELECT version, recovery_wrapped_key FROM space_keys
        WHERE space_id = $1 AND deleted_at IS NULL ORDER BY version`,
      [spaceId],
    );
    return Promise.all(
      rows.map((r) =>
        openSpaceKey(r.recovery_wrapped_key, kit.publicKey, kit.privateKey),
      ),
    );
  };

  const recoverBody = async (
    keys: Uint8Array[],
    to: KeyedUser,
    proof: string,
  ) => ({
    grants: await Promise.all(
      keys.map(async (key, i) => ({
        version: i + 1,
        wrappedKey: await sealSpaceKey(key, to.account.publicKey),
      })),
    ),
    currentAuthProof: proof,
  });

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    owner = await s.signUpKeyed('r-owner@example.com', 'Olivia');
    admin2 = await s.signUpKeyed('r-admin2@example.com', 'Bruno');
    ana = await s.signUpKeyed('r-ana@example.com', 'Ana');
    bia = await s.signUpKeyed('r-bia@example.com', 'Bia');
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('a new kit sets recoveryRewrapRequired; the old kit is refused (409); rewrapping with the current kit clears it', async () => {
    const { orgId, kit, spaceId, keys } = await setup('Rewrap');
    const v2 = await generateSpaceKey();
    await expectStatus(
      s.rotate(owner.token, spaceId, {
        version: 2,
        key: v2,
        recipients: [recipientOf(owner)],
        kitPublicKey: kit.publicKey,
      }),
      201,
    );
    keys.push(v2);
    await expectStatus(
      s.addMember(owner.token, spaceId, recipientOf(ana), keys),
      201,
    );

    const kit2 = await recoveryKitKeypair();
    await s.setRecoveryKit(owner, orgId, kit2.publicKey).expect(204);
    const flagged = await c
      .http()
      .get(`/spaces/${spaceId}`)
      .set(h(ana))
      .expect(200);
    expect(flagged.body.recoveryRewrapRequired).toBe(true);
    const listed = await c
      .http()
      .get(`/organizations/${orgId}/spaces`)
      .set(h(ana))
      .expect(200);
    expect(listed.body.items[0].recoveryRewrapRequired).toBe(true);

    // the app still had the old kit: rewrap and rotation are refused
    const old = await s.rewrapRecovery(ana.token, spaceId, kit.publicKey, keys);
    expect(old.status).toBe(409);
    expect(old.body.type).toMatch(/\/recovery-key-changed$/);
    const v3 = await generateSpaceKey();
    // (no rotation pending: the manager rotates)
    const oldRotation = await s.rotate(owner.token, spaceId, {
      version: 3,
      key: v3,
      recipients: [recipientOf(owner), recipientOf(ana)],
      kitPublicKey: kit.publicKey,
    });
    expect(oldRotation.status).toBe(409);
    expect(oldRotation.body.type).toMatch(/\/recovery-key-changed$/);

    // a rotation with the new kit only covers v3: v1 and v2 stay pending
    await expectStatus(
      s.rotate(owner.token, spaceId, {
        version: 3,
        key: v3,
        recipients: [recipientOf(owner), recipientOf(ana)],
        kitPublicKey: kit2.publicKey,
      }),
      201,
    );
    keys.push(v3);
    expect(
      (await c.http().get(`/spaces/${spaceId}`).set(h(ana)).expect(200)).body
        .recoveryRewrapRequired,
    ).toBe(true);

    // a partial set is refused
    const partial = await s.rewrapRecovery(
      ana.token,
      spaceId,
      kit2.publicKey,
      keys,
      [1],
    );
    expect(partial.status).toBe(409);
    expect(partial.body.type).toMatch(/\/key-versions-mismatch$/);

    // exactly the stale versions (any member may do it)
    const ok = await expectStatus(
      s.rewrapRecovery(ana.token, spaceId, kit2.publicKey, keys, [1, 2]),
      200,
    );
    expect(ok.body).toEqual({ versions: [1, 2] });
    expect(
      (await c.http().get(`/spaces/${spaceId}`).set(h(ana)).expect(200)).body
        .recoveryRewrapRequired,
    ).toBe(false);
    // every version opens with the new kit
    expect(await openWithKit(spaceId, kit2)).toEqual(keys);
    const audit = await auditRows(orgId, 'space.recovery_rewrapped');
    expect(audit.map((a) => a.metadata)).toEqual([
      { spaceId, versions: [1, 2] },
    ]);

    // all versions again is also accepted
    await expectStatus(
      s.rewrapRecovery(owner.token, spaceId, kit2.publicKey, keys),
      200,
    );
  });

  it('recover: a space with members is not orphan (409); an orphan reopens with the kit, reauthenticated and audited', async () => {
    const { orgId, kit, spaceId, keys } = await setup('Orphan');
    await expectStatus(
      s.addMember(owner.token, spaceId, recipientOf(ana), keys),
      201,
    );
    const kitKeys = await openWithKit(spaceId, kit);
    expect(kitKeys).toEqual(keys);

    const notOrphan = await c
      .http()
      .post(`/spaces/${spaceId}/recover`)
      .set(h(admin2))
      .send(await recoverBody(kitKeys, admin2, admin2.account.authProof))
      .expect(409);
    expect(notOrphan.body.type).toMatch(/\/space-not-orphan$/);

    // ana is removed, then the last member (the manager) leaves: nobody holds the key
    await c
      .http()
      .delete(`/spaces/${spaceId}/members/${ana.userId}`)
      .set(h(owner))
      .expect(204);
    await c.http().post(`/spaces/${spaceId}/leave`).set(h(owner)).expect(204);
    expect(await activeSpaceMembers(spaceId)).toEqual([]);

    // a plain org member cannot even see it (404)
    await c
      .http()
      .post(`/spaces/${spaceId}/recover`)
      .set(h(bia))
      .send(await recoverBody(kitKeys, bia, bia.account.authProof))
      .expect(404);
    // wrong proof: 422, nothing changes
    const wrong = await c
      .http()
      .post(`/spaces/${spaceId}/recover`)
      .set(h(admin2))
      .send(await recoverBody(kitKeys, admin2, owner.account.authProof))
      .expect(422);
    expect(wrong.body.type).toMatch(/\/current-auth-proof-invalid$/);
    expect(JSON.stringify(wrong.body)).not.toContain(owner.account.authProof);
    // missing proof: validation
    await c
      .http()
      .post(`/spaces/${spaceId}/recover`)
      .set(h(admin2))
      .send({ grants: (await recoverBody(kitKeys, admin2, 'x')).grants })
      .expect(422);
    expect(await activeSpaceMembers(spaceId)).toEqual([]);

    const ok = await c
      .http()
      .post(`/spaces/${spaceId}/recover`)
      .set(h(admin2))
      .send(await recoverBody(kitKeys, admin2, admin2.account.authProof))
      .expect(200);
    expect(ok.body).toEqual({ roleKey: 'space_manager' });
    const opened = await s.openKeys(admin2, spaceId);
    expect(opened.keys.get(1)).toEqual(keys[0]);
    expect(await activeSpaceMembers(spaceId)).toEqual([admin2.userId]);

    const audit = await auditRows(orgId, 'space.recovered_with_kit');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.user_id).toBe(admin2.userId);
    expect(audit[0]!.metadata).toMatchObject({ spaceId });
    const dump = JSON.stringify(audit);
    expect(dump).not.toContain(admin2.account.authProof);
    expect(dump).not.toMatch(/wrapped/i);

    // no longer orphan
    await c
      .http()
      .post(`/spaces/${spaceId}/recover`)
      .set(h(owner))
      .send(await recoverBody(kitKeys, owner, owner.account.authProof))
      .expect(409);
  });

  it('promotes an existing member to manager only when the space has none; otherwise 409', async () => {
    const { orgId, kit } = await setup('Promote');
    // a manager who will leave the organization
    const temp = await s.signUpKeyed('r-temp@example.com', 'Tito');
    await s.joinOrg(owner, orgId, temp, 'org_admin');
    const space = await s.create(temp, orgId, kit.publicKey, 'Managed');
    await expectStatus(
      s.addMember(temp.token, space.spaceId, recipientOf(ana), [space.key]),
      201,
    );

    const hasManager = await c
      .http()
      .post(`/spaces/${space.spaceId}/managers`)
      .set(h(owner))
      .send({ userId: ana.userId })
      .expect(409);
    expect(hasManager.body.type).toMatch(/\/space-has-manager$/);

    await c
      .http()
      .delete(`/organizations/${orgId}/members/${temp.userId}`)
      .set(h(owner))
      .expect(204);
    expect(await activeSpaceMembers(space.spaceId)).toEqual([ana.userId]);

    // a plain org member cannot see the space (404); the member herself lacks the org permission (403)
    await c
      .http()
      .post(`/spaces/${space.spaceId}/managers`)
      .set(h(bia))
      .send({ userId: ana.userId })
      .expect(404);
    await c
      .http()
      .post(`/spaces/${space.spaceId}/managers`)
      .set(h(ana))
      .send({ userId: ana.userId })
      .expect(403);
    // only an existing member can be promoted
    const notMember = await c
      .http()
      .post(`/spaces/${space.spaceId}/managers`)
      .set(h(owner))
      .send({ userId: bia.userId })
      .expect(404);
    expect(notMember.body.type).toMatch(/\/space-member-not-found$/);
    // the admin cannot promote themself into the space
    await c
      .http()
      .post(`/spaces/${space.spaceId}/managers`)
      .set(h(owner))
      .send({ userId: owner.userId })
      .expect(404);

    const ok = await c
      .http()
      .post(`/spaces/${space.spaceId}/managers`)
      .set(h(owner))
      .send({ userId: ana.userId })
      .expect(200);
    expect(ok.body).toEqual({ userId: ana.userId, roleKey: 'space_manager' });
    expect(await activeSpaceMembers(space.spaceId)).toEqual([ana.userId]);
    // the admin still cannot read the space
    await c.http().get(`/spaces/${space.spaceId}`).set(h(owner)).expect(404);
    expect(await auditRows(orgId, 'space.manager_promoted')).toHaveLength(1);
    expect((await spaceRow(space.spaceId)).key_rotation_required).toBe(true);
  });
});
