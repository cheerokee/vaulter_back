import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
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

const MISSING_ID = '0190f3c0-0000-7000-8000-000000000000';
/** Structurally valid sealed copy (81 bytes, version byte 0x01): passes the DTO and the domain format check. */
const DUMMY_WK = Buffer.alloc(81, 1).toString('base64url');

describe('Spaces endpoints (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = (u: KeyedUser) => c.bearer(u.token);

  /** Every /spaces/:id route with a body that passes validation, so the answer comes from the use case. */
  const everyRoute = (spaceId: string, userId: string, kitPk: string) => {
    const base = `/spaces/${spaceId}`;
    return [
      ['GET', base, undefined],
      ['PATCH', base, { name: 'x' }],
      ['GET', `${base}/members`, undefined],
      [
        'POST',
        `${base}/members`,
        {
          userId,
          roleKey: 'space_reader',
          grants: [{ version: 1, wrappedKey: DUMMY_WK }],
        },
      ],
      ['PATCH', `${base}/members/${userId}`, { roleKey: 'space_reader' }],
      ['DELETE', `${base}/members/${userId}`, undefined],
      ['POST', `${base}/leave`, undefined],
      ['GET', `${base}/keys`, undefined],
      [
        'POST',
        `${base}/keys`,
        {
          version: 2,
          recoveryPublicKey: kitPk,
          recoveryWrappedKey: DUMMY_WK,
          grants: [{ userId, wrappedKey: DUMMY_WK }],
        },
      ],
      [
        'PUT',
        `${base}/keys/recovery`,
        {
          recoveryPublicKey: kitPk,
          versions: [{ version: 1, wrappedKey: DUMMY_WK }],
        },
      ],
      ['POST', `${base}/managers`, { userId }],
      [
        'POST',
        `${base}/recover`,
        {
          grants: [{ version: 1, wrappedKey: DUMMY_WK }],
          currentAuthProof: 'A'.repeat(43),
        },
      ],
      ['GET', `${base}/pending-grants`, undefined],
      ['DELETE', `${base}/pending-grants/${MISSING_ID}`, undefined],
    ] as const;
  };

  const send = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    token: string,
    body?: object,
  ) => {
    const agent = request(app.getHttpServer());
    const req =
      method === 'GET'
        ? agent.get(url)
        : method === 'POST'
          ? agent.post(url)
          : method === 'PATCH'
            ? agent.patch(url)
            : method === 'PUT'
              ? agent.put(url)
              : agent.delete(url);
    req.set(c.bearer(token));
    return body ? req.send(body) : req;
  };

  let owner: KeyedUser;
  let admin2: KeyedUser;
  let member: KeyedUser;
  let orgId: string;
  let kit: { publicKey: string; privateKey: Uint8Array };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    owner = await s.signUpKeyed('sp-owner@example.com', 'Olivia');
    admin2 = await s.signUpKeyed('sp-admin2@example.com', 'Bruno');
    member = await s.signUpKeyed('sp-member@example.com', 'Maria');
    ({ orgId, kit } = await s.orgWithKit(owner, 'Acme'));
    await s.joinOrg(owner, orgId, admin2, 'org_admin');
    await s.joinOrg(owner, orgId, member, 'org_member');
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('requires authentication', async () => {
    await c.http().get(`/organizations/${orgId}/spaces`).expect(401);
    await c.http().get(`/spaces/${MISSING_ID}`).expect(401);
  });

  it('creates a space with the kit; the creator opens v1 with their own private key', async () => {
    const { res, key, spaceId } = await s.create(owner, orgId, kit.publicKey);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      organizationId: orgId,
      name: 'Manuais',
      roleKey: 'space_manager',
      currentKeyVersion: 1,
      keyRotationRequired: false,
      recoveryRewrapRequired: false,
    });
    expect(res.body.createdAt).toMatch(/Z$/);
    expect(JSON.stringify(res.body)).not.toMatch(/wrapped/i);

    const opened = await s.openKeys(owner, spaceId);
    expect(opened.currentVersion).toBe(1);
    expect(opened.keys.get(1)).toEqual(key);

    const details = await c
      .http()
      .get(`/spaces/${spaceId}`)
      .set(h(owner))
      .expect(200);
    expect(details.body).toMatchObject({
      id: spaceId,
      roleKey: 'space_manager',
      currentKeyVersion: 1,
      pendingGrants: 0,
    });

    const members = await s.members(owner.token, spaceId).expect(200);
    expect(members.body.items).toEqual([
      {
        userId: owner.userId,
        name: 'Olivia',
        email: owner.email,
        publicKey: owner.account.publicKey,
        roleKey: 'space_manager',
        joinedAt: expect.stringMatching(/Z$/),
      },
    ]);
    expect(members.body).toHaveProperty('nextCursor', null);
    expect(JSON.stringify(members.body)).not.toMatch(/authHash|auth_hash/);

    // the kit copy is the same key (the organization can reopen the space)
    const rows: { recovery_wrapped_key: string }[] = await (
      await adminDataSource()
    ).query(
      `SELECT recovery_wrapped_key FROM space_keys WHERE space_id = $1 AND version = 1`,
      [spaceId],
    );
    expect(
      await openSpaceKey(
        rows[0]!.recovery_wrapped_key,
        kit.publicKey,
        kit.privateKey,
      ),
    ).toEqual(key);
  });

  it('without a kit: 422 recovery-key-required; with a replaced kit: 409 recovery-key-changed', async () => {
    const noKitOwner = await s.signUpKeyed('sp-nokit@example.com', 'Nina');
    const org = (await c.createOrg(noKitOwner.token, 'No Kit').expect(201)).body
      .id as string;
    const kit1 = await recoveryKitKeypair();
    const missing = await s.create(noKitOwner, org, kit1.publicKey);
    expect(missing.res.status).toBe(422);
    expect(missing.res.body.type).toMatch(/\/recovery-key-required$/);

    await s.setRecoveryKit(noKitOwner, org, kit1.publicKey).expect(204);
    const kit2 = await recoveryKitKeypair();
    await s.setRecoveryKit(noKitOwner, org, kit2.publicKey).expect(204);
    // the app still had the old kit
    const changed = await s.create(noKitOwner, org, kit1.publicKey);
    expect(changed.res.status).toBe(409);
    expect(changed.res.body.type).toMatch(/\/recovery-key-changed$/);
    expect(JSON.stringify(changed.res.body)).not.toContain(kit1.publicKey);

    const count: { n: string }[] = await (
      await adminDataSource()
    ).query(`SELECT count(*) AS n FROM spaces WHERE organization_id = $1`, [
      org,
    ]);
    expect(Number(count[0]!.n)).toBe(0);
  });

  it('validates the body and path ids (422 validation-failed)', async () => {
    const key = await generateSpaceKey();
    const good = {
      name: 'Ok',
      wrappedKey: await sealSpaceKey(key, owner.account.publicKey),
      recoveryPublicKey: kit.publicKey,
      recoveryWrappedKey: await sealSpaceKey(key, kit.publicKey),
    };
    const post = (body: object) =>
      c.http().post(`/organizations/${orgId}/spaces`).set(h(owner)).send(body);
    for (const body of [
      { ...good, name: '' },
      { ...good, name: 'n'.repeat(256) },
      { ...good, wrappedKey: 'short' },
      { ...good, recoveryWrappedKey: undefined },
      { ...good, recoveryPublicKey: 'x'.repeat(44) },
      { ...good, extra: true },
    ]) {
      const res = await post(body).expect(422);
      expect(res.body.type).toMatch(/\/validation-failed$/);
    }
    // a well-formed but non-v1 copy is rejected by the domain
    const badVersion = Buffer.alloc(81, 0).toString('base64url');
    const res = await post({ ...good, wrappedKey: badVersion }).expect(422);
    expect(res.body.type).toMatch(/\/wrapped-key-invalid$/);
    await post({ ...good, name: 'n'.repeat(255) }).expect(201);

    for (const url of [
      '/spaces/not-a-uuid',
      '/spaces/not-a-uuid/members',
      '/spaces/not-a-uuid/keys',
      `/organizations/not-a-uuid/spaces`,
    ]) {
      const r = await c.http().get(url).set(h(owner)).expect(422);
      expect(r.body.type).toMatch(/\/validation-failed$/);
    }
    const patch = await c
      .http()
      .patch(`/spaces/${MISSING_ID}/members/not-a-uuid`)
      .set(h(owner))
      .send({ roleKey: 'space_reader' })
      .expect(422);
    expect(patch.body.type).toMatch(/\/validation-failed$/);
    const del = await c
      .http()
      .delete(`/spaces/${MISSING_ID}/pending-grants/nope`)
      .set(h(owner))
      .expect(422);
    expect(del.body.type).toMatch(/\/validation-failed$/);
  });

  it('a plain member cannot create spaces (403); renames need the manager (403 for an editor)', async () => {
    const forbidden = await s.create(member, orgId, kit.publicKey);
    expect(forbidden.res.status).toBe(403);

    const { spaceId, key } = await s.create(owner, orgId, kit.publicKey, 'R');
    await expectStatus(
      s.addMember(owner.token, spaceId, recipientOf(member), [key]),
      201,
    );
    const asEditor = await c
      .http()
      .patch(`/spaces/${spaceId}`)
      .set(h(member))
      .send({ name: 'Nope' })
      .expect(403);
    expect(asEditor.body.type).toMatch(/\/permission-denied$/);
    const renamed = await c
      .http()
      .patch(`/spaces/${spaceId}`)
      .set(h(owner))
      .send({ name: 'Renomeado' })
      .expect(200);
    expect(renamed.body).toMatchObject({ id: spaceId, name: 'Renomeado' });
    expect(renamed.body.updatedAt).toMatch(/Z$/);
    // the editor sees the space without the manager-only count
    const asMember = await c
      .http()
      .get(`/spaces/${spaceId}`)
      .set(h(member))
      .expect(200);
    expect(asMember.body.roleKey).toBe('space_editor');
    expect(asMember.body).not.toHaveProperty('pendingGrants');
  });

  it('lists my spaces (with role and flags) and, with org.spaces.create, all of them (?all=true)', async () => {
    const lister = await s.signUpKeyed('sp-lister@example.com', 'Lia');
    const { orgId: org, kit: k } = await s.orgWithKit(lister, 'Lister Inc');
    const a = await s.create(lister, org, k.publicKey, 'A');
    const b = await s.create(lister, org, k.publicKey, 'B');
    const plain = await s.signUpKeyed('sp-plain@example.com', 'Paulo');
    await s.joinOrg(lister, org, plain);
    await expectStatus(
      s.addMember(lister.token, a.spaceId, recipientOf(plain), [a.key]),
      201,
    );

    const mine = await c
      .http()
      .get(`/organizations/${org}/spaces`)
      .set(h(plain))
      .expect(200);
    expect(mine.body.items).toEqual([
      expect.objectContaining({
        id: a.spaceId,
        name: 'A',
        roleKey: 'space_editor',
        currentKeyVersion: 1,
        keyRotationRequired: false,
        recoveryRewrapRequired: false,
        createdAt: expect.stringMatching(/Z$/),
      }),
    ]);
    expect(mine.body.items[0]).not.toHaveProperty('pendingGrants');
    expect(mine.body.nextCursor).toBeNull();

    const managerList = await c
      .http()
      .get(`/organizations/${org}/spaces?limit=1`)
      .set(h(lister))
      .expect(200);
    expect(managerList.body.items).toHaveLength(1);
    expect(managerList.body.items[0].pendingGrants).toBe(0);
    expect(managerList.body.nextCursor).toEqual(expect.any(String));
    const next = await c
      .http()
      .get(
        `/organizations/${org}/spaces?limit=1&cursor=${managerList.body.nextCursor as string}`,
      )
      .set(h(lister))
      .expect(200);
    const pagedIds: string[] = [
      managerList.body.items[0].id,
      next.body.items[0].id,
    ];
    expect(pagedIds.sort()).toEqual([a.spaceId, b.spaceId].sort());

    const all = await c
      .http()
      .get(`/organizations/${org}/spaces?all=true`)
      .set(h(lister))
      .expect(200);
    expect(
      (all.body.items as { id: string }[]).map((i) => i.id).sort(),
    ).toEqual([a.spaceId, b.spaceId].sort());
    const itemA = (
      all.body.items as { id: string; memberCount: number }[]
    ).find((i) => i.id === a.spaceId)!;
    expect(Object.keys(itemA).sort()).toEqual(
      [
        'createdAt',
        'id',
        'memberCount',
        'name',
        'recoveryRewrapRequired',
      ].sort(),
    );
    expect(itemA.memberCount).toBe(2);

    const forbidden = await c
      .http()
      .get(`/organizations/${org}/spaces?all=true`)
      .set(h(plain))
      .expect(403);
    expect(forbidden.body.type).toMatch(/\/permission-denied$/);
    await c
      .http()
      .get(`/organizations/${org}/spaces?all=yes`)
      .set(h(lister))
      .expect(422);
    // outside the organization: 404
    await c
      .http()
      .get(`/organizations/${org}/spaces`)
      .set(h(member))
      .expect(404);
  });

  it('an org admin outside the space gets 404 on details, members and keys, and cannot add anyone (not even themself)', async () => {
    const { spaceId, key } = await s.create(owner, orgId, kit.publicKey, 'X');
    for (const url of [
      `/spaces/${spaceId}`,
      `/spaces/${spaceId}/members`,
      `/spaces/${spaceId}/keys`,
      `/spaces/${spaceId}/pending-grants`,
    ]) {
      const res = await c.http().get(url).set(h(admin2)).expect(404);
      expect(res.body.type).toMatch(/\/space-not-found$/);
    }
    for (const target of [admin2, member]) {
      const res = await s.addMember(
        admin2.token,
        spaceId,
        recipientOf(target),
        [key],
      );
      expect(res.status).toBe(404);
      expect(res.body.type).toMatch(/\/space-not-found$/);
    }
    // nor rotate, rename or rewrap
    const rot = await s.rotate(admin2.token, spaceId, {
      version: 2,
      key: await generateSpaceKey(),
      recipients: [recipientOf(owner)],
      kitPublicKey: kit.publicKey,
    });
    expect(rot.status).toBe(404);
    await c
      .http()
      .patch(`/spaces/${spaceId}`)
      .set(h(admin2))
      .send({ name: 'mine' })
      .expect(404);
    const rows: { n: string }[] = await (
      await adminDataSource()
    ).query(
      `SELECT count(*) AS n FROM role_assignments WHERE space_id = $1 AND deleted_at IS NULL`,
      [spaceId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('isolation: a space id of another organization answers 404 on every route', async () => {
    const other = await s.signUpKeyed('sp-other@example.com', 'Otto');
    const { orgId: otherOrg, kit: otherKit } = await s.orgWithKit(
      other,
      'Other',
    );
    const foreign = await s.create(other, otherOrg, otherKit.publicKey, 'F');
    expect(foreign.res.status).toBe(201);

    // owner is admin of their own org and manager of spaces there; none of it reaches the other org
    for (const [method, url, body] of everyRoute(
      foreign.spaceId,
      other.userId,
      otherKit.publicKey,
    )) {
      const res = await send(method, url, owner.token, body);
      expect({ method, url, status: res.status }).toEqual({
        method,
        url,
        status: 404,
      });
      expect(res.body.type).toMatch(/\/space-not-found$/);
    }
    // a nonexistent id behaves the same way
    for (const [method, url, body] of everyRoute(
      MISSING_ID,
      other.userId,
      otherKit.publicKey,
    )) {
      const res = await send(method, url, owner.token, body);
      expect({ method, url, status: res.status }).toEqual({
        method,
        url,
        status: 404,
      });
    }
    // and nothing changed over there
    const opened = await s.openKeys(other, foreign.spaceId);
    expect(opened.currentVersion).toBe(1);
    expect(opened.keys.get(1)).toEqual(foreign.key);
    const list = await c
      .http()
      .get(`/organizations/${otherOrg}/spaces`)
      .set(h(owner))
      .expect(404);
    expect(list.body.type).toMatch(/\/organization-not-found$/);
  }, 60_000);

  it('the public Swagger document has no spaces route; the internal one has them all', async () => {
    const pub = await c.http().get('/docs/public/json').expect(200);
    const publicPaths = Object.keys(pub.body.paths as Record<string, unknown>);
    expect(publicPaths.filter((p) => p.includes('spaces'))).toEqual([]);
    const internal = await c.http().get('/docs/json').expect(200);
    const internalPaths = Object.keys(
      internal.body.paths as Record<string, unknown>,
    );
    for (const path of [
      '/organizations/{orgId}/spaces',
      '/spaces/{id}',
      '/spaces/{id}/members',
      '/spaces/{id}/members/{userId}',
      '/spaces/{id}/leave',
      '/spaces/{id}/keys',
      '/spaces/{id}/keys/recovery',
      '/spaces/{id}/managers',
      '/spaces/{id}/recover',
      '/spaces/{id}/pending-grants',
      '/spaces/{id}/pending-grants/{pendingGrantId}',
    ]) {
      expect(internalPaths).toContain(path);
    }
    expect(JSON.stringify(internal.body.paths['/spaces/{id}'])).toContain(
      'bearer',
    );
  });
});
