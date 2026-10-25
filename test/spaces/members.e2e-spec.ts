import type { INestApplication } from '@nestjs/common';
import { MemberRemovedHooks } from '../../src/shared/application/member-removed-hooks.js';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import { generateSpaceKey, openSpaceKey } from '../support/client-crypto.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
  recipientOf,
} from '../support/identity-client.js';
import {
  activeSpaceMembers,
  auditRows,
  grantsOfNonMembers,
  membersMissingVersions,
  spaceRow,
  versionsEverGranted,
} from '../support/spaces-db.js';

describe('Space members and key rotation (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = (u: KeyedUser) => c.bearer(u.token);

  let owner: KeyedUser;
  let ana: KeyedUser;
  let bia: KeyedUser;
  let caio: KeyedUser;
  let stranger: KeyedUser;

  /** Fresh organization (owner + ana, bia, caio as org members) with a kit, and a space managed by owner. */
  const setup = async (name: string) => {
    const { orgId, kit } = await s.orgWithKit(owner, name);
    for (const u of [ana, bia, caio]) await s.joinOrg(owner, orgId, u);
    const space = await s.create(owner, orgId, kit.publicKey, name);
    expect(space.res.status).toBe(201);
    return { orgId, kit, spaceId: space.spaceId, keys: [space.key] };
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    owner = await s.signUpKeyed('m-owner@example.com', 'Olivia');
    ana = await s.signUpKeyed('m-ana@example.com', 'Ana');
    bia = await s.signUpKeyed('m-bia@example.com', 'Bia');
    caio = await s.signUpKeyed('m-caio@example.com', 'Caio');
    stranger = await s.signUpKeyed('m-stranger@example.com', 'Sid');
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('a manager adds someone with every version and they open all copies with their own private key', async () => {
    const { orgId, kit, spaceId, keys } = await setup('Add All');
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

    const added = await expectStatus(
      s.addMember(owner.token, spaceId, recipientOf(ana), keys, 'space_reader'),
      201,
    );
    expect(added.body).toEqual({ userId: ana.userId, roleKey: 'space_reader' });

    const opened = await s.openKeys(ana, spaceId);
    expect(opened.currentVersion).toBe(2);
    expect([...opened.keys.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(opened.keys.get(1)).toEqual(keys[0]);
    expect(opened.keys.get(2)).toEqual(v2);
    // the copy was sealed for ana only: another member's private key does not open it
    const raw = await c
      .http()
      .get(`/spaces/${spaceId}/keys`)
      .set(h(ana))
      .expect(200);
    await expect(
      openSpaceKey(
        raw.body.keys[0].wrappedKey as string,
        owner.account.publicKey,
        owner.account.privateKey,
      ),
    ).rejects.toThrow();

    const members = await s.members(ana.token, spaceId).expect(200);
    expect(
      (members.body.items as { userId: string; publicKey: string }[]).map(
        (m) => [m.userId, m.publicKey],
      ),
    ).toEqual(
      expect.arrayContaining([
        [owner.userId, owner.account.publicKey],
        [ana.userId, ana.account.publicKey],
      ]),
    );
    const audit = await auditRows(orgId, 'space.member_added');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/wrapped/i);
  });

  it('missing a version (or an unknown one): 409 key-versions-mismatch; nothing is written', async () => {
    const { kit, spaceId, keys } = await setup('Mismatch');
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
    const onlyV1 = await s.addMember(
      owner.token,
      spaceId,
      recipientOf(ana),
      keys,
    );
    expect(onlyV1.status).toBe(409);
    expect(onlyV1.body.type).toMatch(/\/key-versions-mismatch$/);
    const extra = await s.addMember(owner.token, spaceId, recipientOf(ana), [
      keys[0]!,
      v2,
      v2,
    ]);
    expect(extra.status).toBe(409);
    expect(await activeSpaceMembers(spaceId)).toEqual([owner.userId]);
    expect(await versionsEverGranted(spaceId, ana.userId)).toEqual([]);
  });

  it('the target must be in the organization (404 member-not-found); no duplicates (409); role in the catalog (422)', async () => {
    const { spaceId, keys } = await setup('Target');
    const outside = await s.addMember(
      owner.token,
      spaceId,
      recipientOf(stranger),
      keys,
    );
    expect(outside.status).toBe(404);
    expect(outside.body.type).toMatch(/\/member-not-found$/);

    await expectStatus(
      s.addMember(owner.token, spaceId, recipientOf(ana), keys),
      201,
    );
    const again = await s.addMember(
      owner.token,
      spaceId,
      recipientOf(ana),
      keys,
    );
    expect(again.status).toBe(409);
    expect(again.body.type).toMatch(/\/space-member-exists$/);

    const badRole = await s.addMember(
      owner.token,
      spaceId,
      recipientOf(bia),
      keys,
      'org_admin',
    );
    expect(badRole.status).toBe(422);
    expect(badRole.body.type).toMatch(/\/validation-failed$/);
    // an editor cannot add (403)
    const asEditor = await s.addMember(
      ana.token,
      spaceId,
      recipientOf(bia),
      keys,
    );
    expect(asEditor.status).toBe(403);
    expect(asEditor.body.type).toMatch(/\/permission-denied$/);
  });

  it('removal marks keyRotationRequired; the rotation with exactly the members works; the person who left gets no v2', async () => {
    const { kit, spaceId, keys } = await setup('Rotate');
    await expectStatus(
      s.addMember(owner.token, spaceId, recipientOf(ana), keys),
      201,
    );
    await expectStatus(
      s.addMember(owner.token, spaceId, recipientOf(bia), keys, 'space_reader'),
      201,
    );

    await c
      .http()
      .delete(`/spaces/${spaceId}/members/${bia.userId}`)
      .set(h(owner))
      .expect(204);
    const flagged = await c
      .http()
      .get(`/spaces/${spaceId}`)
      .set(h(ana))
      .expect(200);
    expect(flagged.body.keyRotationRequired).toBe(true);
    // bia is out: 404 on the space, her copies are tombstoned
    await c.http().get(`/spaces/${spaceId}/keys`).set(h(bia)).expect(404);
    expect(await grantsOfNonMembers(spaceId)).toEqual([]);

    const v2 = await generateSpaceKey();
    // the client still listed bia (one member too many) -> 409
    const tooMany = await s.rotate(ana.token, spaceId, {
      version: 2,
      key: v2,
      recipients: [recipientOf(owner), recipientOf(ana), recipientOf(bia)],
      kitPublicKey: kit.publicKey,
    });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.type).toMatch(/\/key-rotation-mismatch$/);
    const tooFew = await s.rotate(ana.token, spaceId, {
      version: 2,
      key: v2,
      recipients: [recipientOf(ana)],
      kitPublicKey: kit.publicKey,
    });
    expect(tooFew.status).toBe(409);
    expect(tooFew.body.type).toMatch(/\/key-rotation-mismatch$/);
    const wrongVersion = await s.rotate(ana.token, spaceId, {
      version: 3,
      key: v2,
      recipients: [recipientOf(owner), recipientOf(ana)],
      kitPublicKey: kit.publicKey,
    });
    expect(wrongVersion.status).toBe(409);
    expect(wrongVersion.body.type).toMatch(/\/key-rotation-mismatch$/);

    // an editor (not a manager) rotates, sealing for the members the API lists
    const recipients = await s.memberRecipients(ana.token, spaceId);
    expect(recipients.map((r) => r.userId).sort()).toEqual(
      [owner.userId, ana.userId].sort(),
    );
    const ok = await expectStatus(
      s.rotate(ana.token, spaceId, {
        version: 2,
        key: v2,
        recipients,
        kitPublicKey: kit.publicKey,
      }),
      201,
    );
    expect(ok.body).toEqual({ currentVersion: 2 });

    for (const u of [owner, ana]) {
      const opened = await s.openKeys(u, spaceId);
      expect(opened.currentVersion).toBe(2);
      expect(opened.keys.get(1)).toEqual(keys[0]);
      expect(opened.keys.get(2)).toEqual(v2);
    }
    expect(await versionsEverGranted(spaceId, bia.userId)).toEqual([1]);
    expect(await spaceRow(spaceId)).toEqual({
      current_key_version: 2,
      key_rotation_required: false,
    });
    expect(await membersMissingVersions(spaceId)).toEqual([]);
  });

  it('protects the last manager (422) on demote, remove and leave; others can leave and change roles', async () => {
    const { spaceId, keys } = await setup('Last Manager');
    await expectStatus(
      s.addMember(owner.token, spaceId, recipientOf(ana), keys),
      201,
    );
    const demote = await c
      .http()
      .patch(`/spaces/${spaceId}/members/${owner.userId}`)
      .set(h(owner))
      .send({ roleKey: 'space_editor' })
      .expect(422);
    expect(demote.body.type).toMatch(/\/last-space-manager$/);
    const remove = await c
      .http()
      .delete(`/spaces/${spaceId}/members/${owner.userId}`)
      .set(h(owner))
      .expect(422);
    expect(remove.body.type).toMatch(/\/last-space-manager$/);
    const leave = await c
      .http()
      .post(`/spaces/${spaceId}/leave`)
      .set(h(owner))
      .expect(422);
    expect(leave.body.type).toMatch(/\/last-space-manager$/);

    const promoted = await c
      .http()
      .patch(`/spaces/${spaceId}/members/${ana.userId}`)
      .set(h(owner))
      .send({ roleKey: 'space_manager' })
      .expect(200);
    expect(promoted.body).toEqual({
      userId: ana.userId,
      roleKey: 'space_manager',
    });
    await c
      .http()
      .patch(`/spaces/${spaceId}/members/${ana.userId}`)
      .set(h(owner))
      .send({ roleKey: 'nope' })
      .expect(422);
    await c.http().post(`/spaces/${spaceId}/leave`).set(h(owner)).expect(204);
    expect(await activeSpaceMembers(spaceId)).toEqual([ana.userId]);
    expect((await spaceRow(spaceId)).key_rotation_required).toBe(true);
    await c
      .http()
      .patch(`/spaces/${spaceId}/members/${caio.userId}`)
      .set(h(ana))
      .send({ roleKey: 'space_reader' })
      .expect(404);
  });

  it('a join concurrent with a rotation leaves nobody without the new version and gives none to outsiders', async () => {
    for (let round = 0; round < 3; round++) {
      const { kit, spaceId, keys } = await setup(`Race ${round}`);
      await expectStatus(
        s.addMember(owner.token, spaceId, recipientOf(ana), keys),
        201,
      );
      const v2 = await generateSpaceKey();
      // both clients prepared their request from the same snapshot (members owner+ana, version 1)
      const [add, rot] = await Promise.all([
        s.addMember(owner.token, spaceId, recipientOf(caio), keys),
        s.rotate(ana.token, spaceId, {
          version: 2,
          key: v2,
          recipients: [recipientOf(owner), recipientOf(ana)],
          kitPublicKey: kit.publicKey,
        }),
      ]);
      expect([add.status, rot.status].sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
      if (add.status === 409) {
        expect(add.body.type).toMatch(/\/key-versions-mismatch$/);
      } else {
        expect(rot.body.type).toMatch(/\/key-rotation-mismatch$/);
      }
      expect(await membersMissingVersions(spaceId)).toEqual([]);
      expect(await grantsOfNonMembers(spaceId)).toEqual([]);
      const row = await spaceRow(spaceId);
      for (const u of [owner, ana, caio]) {
        if (!(await activeSpaceMembers(spaceId)).includes(u.userId)) continue;
        const opened = await s.openKeys(u, spaceId);
        expect(opened.keys.size).toBe(row.current_key_version);
      }
    }
  }, 60_000);

  it('leaving the organization removes the person from every space and marks the rotation, in one transaction', async () => {
    const { orgId, kit, spaceId, keys } = await setup('Org Removal');
    const second = await s.create(owner, orgId, kit.publicKey, 'Second');
    await expectStatus(
      s.addMember(owner.token, spaceId, recipientOf(ana), keys),
      201,
    );
    await expectStatus(
      s.addMember(owner.token, second.spaceId, recipientOf(ana), [second.key]),
      201,
    );
    await expectStatus(
      s.addMember(owner.token, spaceId, recipientOf(bia), keys),
      201,
    );

    await c
      .http()
      .delete(`/organizations/${orgId}/members/${ana.userId}`)
      .set(h(owner))
      .expect(204);
    for (const id of [spaceId, second.spaceId]) {
      expect(await activeSpaceMembers(id)).not.toContain(ana.userId);
      expect(await grantsOfNonMembers(id)).toEqual([]);
      const got = await c.http().get(`/spaces/${id}`).set(h(owner)).expect(200);
      expect(got.body.keyRotationRequired).toBe(true);
    }
    const removed = (await auditRows(orgId, 'space.member_removed')).filter(
      (r) => r.metadata.targetUserId === ana.userId,
    );
    expect(removed).toHaveLength(2);
    expect(removed.map((r) => r.metadata.reason)).toEqual([
      'organization_removed',
      'organization_removed',
    ]);

    // bia leaves the organization herself
    await c
      .http()
      .post(`/organizations/${orgId}/leave`)
      .set(h(bia))
      .expect(204);
    expect(await activeSpaceMembers(spaceId)).toEqual([owner.userId]);
    const left = (await auditRows(orgId, 'space.member_removed')).filter(
      (r) => r.metadata.targetUserId === bia.userId,
    );
    expect(left.map((r) => r.metadata.reason)).toEqual(['organization_left']);
  });

  it('a failing member-removed hook undoes everything, the spaces included', async () => {
    const { orgId, spaceId, keys } = await setup('Hook Fail');
    await expectStatus(
      s.addMember(owner.token, spaceId, recipientOf(ana), keys),
      201,
    );
    const hooks = app.get(MemberRemovedHooks);
    // registered after the spaces hook: it runs once the spaces work is done, then throws
    hooks.register({
      name: 'e2e-throwing',
      onMemberRemoved: () => Promise.reject(new Error('hook exploded')),
    });
    try {
      const res = await c
        .http()
        .delete(`/organizations/${orgId}/members/${ana.userId}`)
        .set(h(owner));
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('hook exploded');
    } finally {
      hooks.unregister('e2e-throwing');
    }
    expect(await activeSpaceMembers(spaceId)).toEqual(
      [owner.userId, ana.userId].sort(),
    );
    expect(await membersMissingVersions(spaceId)).toEqual([]);
    expect((await spaceRow(spaceId)).key_rotation_required).toBe(false);
    expect(await auditRows(orgId, 'space.member_removed')).toEqual([]);
    const opened = await s.openKeys(ana, spaceId);
    expect(opened.keys.get(1)).toEqual(keys[0]);
  });

  it('adding someone concurrently with their removal from the organization never leaves an active copy for a non-member', async () => {
    for (let round = 0; round < 3; round++) {
      const { orgId, spaceId, keys } = await setup(`Add vs Removal ${round}`);
      const [add, removal] = await Promise.all([
        s.addMember(owner.token, spaceId, recipientOf(caio), keys),
        c
          .http()
          .delete(`/organizations/${orgId}/members/${caio.userId}`)
          .set(h(owner)),
      ]);
      expect(removal.status).toBe(204);
      expect([201, 404]).toContain(add.status);
      if (add.status === 404) {
        expect(add.body.type).toMatch(/\/member-not-found$/);
      }
      // the person ends up in neither; if the add went through first, the space must rotate
      expect(await activeSpaceMembers(spaceId)).toEqual([owner.userId]);
      expect(await grantsOfNonMembers(spaceId)).toEqual([]);
      expect((await spaceRow(spaceId)).key_rotation_required).toBe(
        add.status === 201,
      );
    }
  }, 60_000);
});
