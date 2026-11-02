import type { INestApplication } from '@nestjs/common';
import { ConflictError } from '../../src/shared/domain/errors.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  SpaceMemberLeftHooks,
  type SpaceMemberLeftContext,
} from '../../src/shared/application/space-member-left-hooks.js';
import { UnitOfWork } from '../../src/shared/infra/db/unit-of-work.js';
import { SpaceRoomService } from '../../src/spaces/application/space-room.service.js';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import {
  generateSpaceKey,
  openSpaceKey,
  sealSpaceKey,
} from '../support/client-crypto.js';
import { createHubIdentity, type HubIdentity } from '../support/hub-crypto.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
  recipientOf,
} from '../support/identity-client.js';
import {
  activeSpaceMembers,
  auditRows,
  hubRoom,
  hubWrappedKey,
  insertHub,
  spaceRow,
} from '../support/spaces-db.js';

// A Sala dos Hubs vista pelo `spaces` (as rotas chegam com o módulo de hubs): o serviço é chamado direto, com
// uma linha crua em `hubs` (dona: Olivia; as FKs de hub_id/room_hub_id exigem o Hub) e um par X25519 novo como
// chave de cifra do Hub. A cópia selada para o Hub é aberta com a chave privada dele, como o aparelho faria.
describe('Hub Room in a space (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = (u: KeyedUser) => c.bearer(u.token);
  const actor = (u: KeyedUser) => ({ userId: u.userId, sessionId: newId() });
  const room = () => app.get(SpaceRoomService);
  const linked = async () => undefined;

  let owner: KeyedUser;
  let ana: KeyedUser;
  let bia: KeyedUser;

  const setup = async (name: string) => {
    const { orgId, kit } = await s.orgWithKit(owner, name);
    for (const u of [ana, bia]) await s.joinOrg(owner, orgId, u);
    const space = await s.create(owner, orgId, kit.publicKey, name);
    expect(space.res.status).toBe(201);
    await expectStatus(
      s.addMember(owner.token, space.spaceId, recipientOf(ana), [space.key]),
      201,
    );
    return { orgId, kit, spaceId: space.spaceId, keys: [space.key] };
  };

  const newHub = async (): Promise<{
    hubId: string;
    identity: HubIdentity;
  }> => {
    const identity = await createHubIdentity();
    return { hubId: await insertHub(owner.userId, identity), identity };
  };

  const grant = async (
    by: KeyedUser,
    spaceId: string,
    kitPublicKey: string,
    hub: { hubId: string; identity: HubIdentity },
    keys: Uint8Array[],
    roleKey?: string,
  ) =>
    room().grantRoom(actor(by), {
      hubId: hub.hubId,
      spaceId,
      ...(roleKey ? { roleKey } : {}),
      recoveryPublicKey: kitPublicKey,
      grants: await Promise.all(
        keys.map(async (key, i) => ({
          version: i + 1,
          wrappedKey: await sealSpaceKey(key, hub.identity.encryptionPublicKey),
        })),
      ),
      confirmHubLink: linked,
    });

  const hubOpens = async (
    spaceId: string,
    hub: { hubId: string; identity: HubIdentity },
    version: number,
  ) =>
    openSpaceKey(
      (await hubWrappedKey(spaceId, hub.hubId, version))!,
      hub.identity.encryptionPublicKey,
      hub.identity.encryptionPrivateKey,
    );

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    owner = await s.signUpKeyed('r-owner@example.com', 'Olivia');
    ana = await s.signUpKeyed('r-ana@example.com', 'Ana');
    bia = await s.signUpKeyed('r-bia@example.com', 'Bia');
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('the manager opens the space in the Room with every version; the hub opens its copies; the Room is not a person', async () => {
    const { orgId, kit, spaceId, keys } = await setup('Room Grant');
    const v2 = await generateSpaceKey();
    await expectStatus(
      s.rotate(owner.token, spaceId, {
        version: 2,
        key: v2,
        recipients: [recipientOf(owner), recipientOf(ana)],
        kitPublicKey: kit.publicKey,
      }),
      201,
    );
    keys.push(v2);
    const hub = await newHub();

    await expect(
      grant(owner, spaceId, kit.publicKey, hub, keys),
    ).resolves.toEqual({ hubId: hub.hubId, spaceId, roleKey: 'space_reader' });
    expect(await hubRoom(spaceId, hub.hubId)).toEqual({
      roleKey: 'space_reader',
      versions: [1, 2],
      tombstoned: 0,
    });
    expect(await hubOpens(spaceId, hub, 1)).toEqual(keys[0]);
    expect(await hubOpens(spaceId, hub, 2)).toEqual(v2);

    // the Room never shows up as a person: members list, member count, people invariants
    const members = await c
      .http()
      .get(`/spaces/${spaceId}/members`)
      .set(h(owner))
      .expect(200);
    expect(
      (members.body.items as { userId: string }[]).map((m) => m.userId).sort(),
    ).toEqual([owner.userId, ana.userId].sort());
    expect(await activeSpaceMembers(spaceId)).toEqual(
      [owner.userId, ana.userId].sort(),
    );
    const all = await c
      .http()
      .get(`/organizations/${orgId}/spaces?all=true`)
      .set(h(owner))
      .expect(200);
    expect(
      (all.body.items as { id: string; memberCount: number }[]).find(
        (i) => i.id === spaceId,
      )?.memberCount,
    ).toBe(2);

    // granted again (another role): same rows, copies replaced
    await grant(owner, spaceId, kit.publicKey, hub, keys, 'space_editor');
    expect((await hubRoom(spaceId, hub.hubId)).roleKey).toBe('space_editor');

    const audits = await auditRows(orgId, 'hub.room.');
    expect(audits.map((a) => [a.action, a.user_id, a.metadata])).toEqual([
      [
        'hub.room.granted',
        owner.userId,
        { spaceId, hubId: hub.hubId, roleKey: 'space_reader' },
      ],
      [
        'hub.room.granted',
        owner.userId,
        { spaceId, hubId: hub.hubId, roleKey: 'space_editor' },
      ],
    ]);
  });

  it('only a manager, with every version and the current kit; the org policy can block new grants', async () => {
    const { orgId, kit, spaceId, keys } = await setup('Room Rules');
    const hub = await newHub();
    await expect(
      grant(ana, spaceId, kit.publicKey, hub, keys),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      grant(bia, spaceId, kit.publicKey, hub, keys),
    ).rejects.toMatchObject({ code: 'space-not-found' });
    await expect(
      grant(owner, spaceId, kit.publicKey, hub, [
        ...keys,
        await generateSpaceKey(),
      ]),
    ).rejects.toMatchObject({ code: 'key-versions-mismatch' });
    const other = await s.orgWithKit(owner, 'Room Rules Other');
    await expect(
      grant(owner, spaceId, other.kit.publicKey, hub, keys),
    ).rejects.toMatchObject({ code: 'recovery-key-changed' });

    await c
      .http()
      .patch(`/organizations/${orgId}`)
      .set(h(owner))
      .send({ allowRoomSpaces: false })
      .expect(200);
    await expect(
      grant(owner, spaceId, kit.publicKey, hub, keys),
    ).rejects.toMatchObject({ code: 'room-not-allowed' });
    expect(await hubRoom(spaceId, hub.hubId)).toEqual({
      roleKey: null,
      versions: [],
      tombstoned: 0,
    });
    await c
      .http()
      .patch(`/organizations/${orgId}`)
      .set(h(owner))
      .send({ allowRoomSpaces: true })
      .expect(200);
    await grant(owner, spaceId, kit.publicKey, hub, keys);
    // turning the policy off later keeps the existing grant (only new grants are blocked)
    await c
      .http()
      .patch(`/organizations/${orgId}`)
      .set(h(owner))
      .send({ allowRoomSpaces: false })
      .expect(200);
    expect((await hubRoom(spaceId, hub.hubId)).roleKey).toBe('space_reader');
    // and a re-grant / role change of that hub is not a new grant: still allowed
    await grant(owner, spaceId, kit.publicKey, hub, keys, 'space_editor');
    expect((await hubRoom(spaceId, hub.hubId)).roleKey).toBe('space_editor');
    await expect(
      grant(owner, spaceId, kit.publicKey, await newHub(), keys),
    ).rejects.toMatchObject({ code: 'room-not-allowed' });
  });

  it('rotation needs a copy for each Room hub (409 key-rotation-mismatch); with it, the hub opens the new version', async () => {
    const { kit, spaceId, keys } = await setup('Room Rotate');
    const hub = await newHub();
    await grant(owner, spaceId, kit.publicKey, hub, keys);
    const v2 = await generateSpaceKey();
    const people = [recipientOf(owner), recipientOf(ana)];
    const missing = await expectStatus(
      s.rotate(owner.token, spaceId, {
        version: 2,
        key: v2,
        recipients: people,
        kitPublicKey: kit.publicKey,
        hubs: [],
      }),
      409,
    );
    expect(missing.body.type).toMatch(/\/key-rotation-mismatch$/);
    const stranger = await expectStatus(
      s.rotate(owner.token, spaceId, {
        version: 2,
        key: v2,
        recipients: people,
        kitPublicKey: kit.publicKey,
        hubs: [
          { hubId: hub.hubId, publicKey: hub.identity.encryptionPublicKey },
          { hubId: newId(), publicKey: hub.identity.encryptionPublicKey },
        ],
      }),
      409,
    );
    expect(stranger.body.type).toMatch(/\/key-rotation-mismatch$/);
    expect((await spaceRow(spaceId)).current_key_version).toBe(1);

    await expectStatus(
      s.rotate(owner.token, spaceId, {
        version: 2,
        key: v2,
        recipients: people,
        kitPublicKey: kit.publicKey,
        hubs: [
          { hubId: hub.hubId, publicKey: hub.identity.encryptionPublicKey },
        ],
      }),
      201,
    );
    expect(await hubOpens(spaceId, hub, 2)).toEqual(v2);
    expect((await hubRoom(spaceId, hub.hubId)).versions).toEqual([1, 2]);
  });

  it('revokeRoom tombstones role and copies and leaves a pending rotation the hub is not part of', async () => {
    const { orgId, kit, spaceId, keys } = await setup('Room Revoke');
    const hub = await newHub();
    await grant(owner, spaceId, kit.publicKey, hub, keys);
    await expect(
      room().revokeRoom(
        { kind: 'space_manager', userId: ana.userId },
        { hubId: hub.hubId, spaceId, reason: 'revoked' },
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      room().revokeRoom(
        { kind: 'space_manager', userId: owner.userId },
        { hubId: hub.hubId, spaceId, reason: 'revoked' },
      ),
    ).resolves.toBe(true);
    expect(await hubRoom(spaceId, hub.hubId)).toEqual({
      roleKey: null,
      versions: [],
      tombstoned: 1,
    });
    expect((await spaceRow(spaceId)).key_rotation_required).toBe(true);
    await expect(
      room().revokeRoom(
        { kind: 'space_manager', userId: owner.userId },
        { hubId: hub.hubId, spaceId, reason: 'revoked' },
      ),
    ).rejects.toMatchObject({ code: 'room-not-found' });

    // the removed hub gets no copy of the new version
    const v2 = await generateSpaceKey();
    const people = [recipientOf(owner), recipientOf(ana)];
    await expectStatus(
      s.rotate(ana.token, spaceId, {
        version: 2,
        key: v2,
        recipients: people,
        kitPublicKey: kit.publicKey,
        hubs: [
          { hubId: hub.hubId, publicKey: hub.identity.encryptionPublicKey },
        ],
      }),
      409,
    );
    await expectStatus(
      s.rotate(ana.token, spaceId, {
        version: 2,
        key: v2,
        recipients: people,
        kitPublicKey: kit.publicKey,
      }),
      201,
    );
    expect((await hubRoom(spaceId, hub.hubId)).versions).toEqual([]);

    // re-granted later: the same rows come back (tombstone cleared), with every version
    await grant(owner, spaceId, kit.publicKey, hub, [...keys, v2]);
    expect(await hubRoom(spaceId, hub.hubId)).toEqual({
      roleKey: 'space_reader',
      versions: [1, 2],
      tombstoned: 0,
    });
    const actions = (await auditRows(orgId, 'hub.room.')).map((a) => a.action);
    expect(actions).toEqual([
      'hub.room.granted',
      'hub.room.revoked',
      'hub.room.granted',
    ]);
  });

  it('revokeRoomForOrganization / revokeAllRoomForHub take every space of the hub out of the Room, in the caller unit of work', async () => {
    const a = await setup('Room Bulk A');
    const b = await s.create(owner, a.orgId, a.kit.publicKey, 'Room Bulk B');
    const hub = await newHub();
    const other = await newHub();
    await grant(owner, a.spaceId, a.kit.publicKey, hub, a.keys);
    await grant(owner, b.spaceId, a.kit.publicKey, hub, [b.key]);
    await grant(owner, b.spaceId, a.kit.publicKey, other, [b.key]);
    const uow = app.get(UnitOfWork);

    // a failure after the revocation rolls it back
    await expect(
      uow.run(async () => {
        await room().revokeRoomForOrganization({
          hubId: hub.hubId,
          organizationId: a.orgId,
          actorId: owner.userId,
          reason: 'hub_unlinked',
        });
        throw new Error('caller failed');
      }),
    ).rejects.toThrow('caller failed');
    expect((await hubRoom(a.spaceId, hub.hubId)).roleKey).toBe('space_reader');

    const revoked = await uow.run(() =>
      room().revokeAllRoomForHub({
        hubId: hub.hubId,
        organizationIds: [a.orgId, a.orgId],
        actorId: owner.userId,
        reason: 'hub_deregistered',
      }),
    );
    expect(revoked).toEqual([a.spaceId, b.spaceId].sort());
    for (const id of [a.spaceId, b.spaceId]) {
      expect((await hubRoom(id, hub.hubId)).roleKey).toBeNull();
      expect((await hubRoom(id, hub.hubId)).versions).toEqual([]);
      expect((await spaceRow(id)).key_rotation_required).toBe(true);
    }
    // another hub of the same space is untouched
    expect((await hubRoom(b.spaceId, other.hubId)).roleKey).toBe(
      'space_reader',
    );
  });

  describe('space-left hook', () => {
    const seen: SpaceMemberLeftContext[] = [];
    let fail = false;
    beforeAll(() => {
      app.get(SpaceMemberLeftHooks).register({
        name: 'test.space-left',
        onSpaceMemberLeft: async (ctx) => {
          if (fail) throw new ConflictError('test-hook-refused', 'Refused.');
          seen.push(ctx);
        },
      });
    });
    afterAll(() => app.get(SpaceMemberLeftHooks).unregister('test.space-left'));
    beforeEach(() => {
      seen.length = 0;
      fail = false;
    });

    it('is emitted on remove, on leave and once per space on leaving the organization', async () => {
      const { orgId, kit, spaceId, keys } = await setup('Room Hook');
      await expectStatus(
        s.addMember(owner.token, spaceId, recipientOf(bia), keys),
        201,
      );
      const second = await s.create(owner, orgId, kit.publicKey, 'Room Hook 2');
      await expectStatus(
        s.addMember(owner.token, second.spaceId, recipientOf(ana), [
          second.key,
        ]),
        201,
      );

      await c
        .http()
        .delete(`/spaces/${spaceId}/members/${bia.userId}`)
        .set(h(owner))
        .expect(204);
      expect(seen.map((x) => [x.organizationId, x.spaceId, x.userId])).toEqual([
        [orgId, spaceId, bia.userId],
      ]);
      expect(seen[0]!.now).toBeInstanceOf(Date);

      seen.length = 0;
      await c
        .http()
        .post(`/spaces/${second.spaceId}/leave`)
        .set(h(ana))
        .expect(204);
      expect(seen.map((x) => [x.spaceId, x.userId])).toEqual([
        [second.spaceId, ana.userId],
      ]);

      // ana is back in the second space, then leaves the organization: one emission per space
      await expectStatus(
        s.addMember(owner.token, second.spaceId, recipientOf(ana), [
          second.key,
        ]),
        201,
      );
      seen.length = 0;
      await c
        .http()
        .post(`/organizations/${orgId}/leave`)
        .set(h(ana))
        .expect(204);
      expect(seen.map((x) => [x.organizationId, x.spaceId, x.userId])).toEqual(
        [spaceId, second.spaceId].sort().map((id) => [orgId, id, ana.userId]),
      );
    });

    it('a failing subscriber undoes the exit (space leave and organization leave)', async () => {
      const { orgId, spaceId } = await setup('Room Hook Fail');
      fail = true;
      const left = await c.http().post(`/spaces/${spaceId}/leave`).set(h(ana));
      expect(left.status).toBe(409);
      expect(await activeSpaceMembers(spaceId)).toContain(ana.userId);
      expect((await spaceRow(spaceId)).key_rotation_required).toBe(false);
      const orgLeft = await c
        .http()
        .post(`/organizations/${orgId}/leave`)
        .set(h(ana));
      expect(orgLeft.status).toBe(409);
      expect(await activeSpaceMembers(spaceId)).toContain(ana.userId);
    });
  });
});
