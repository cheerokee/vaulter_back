import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { HubTokenService } from '../../src/identity/application/hub-token-service.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { openPrivateKey } from '../support/client-crypto.js';
import { type ClaimedHub, hubsKit } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
  recipientOf,
} from '../support/identity-client.js';

type Item = {
  type: string;
  syncVersion: number;
  deleted: boolean;
  data: Record<string, unknown>;
};
type Page = { items: Item[]; nextSince: number };

/** Every object key at any depth of a JSON value. */
const keysDeep = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(keysDeep)
    : value !== null && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, v]) => [key, ...keysDeep(v)])
      : [];

const PASSWORD = 'correct horse battery staple';

// Sincronização do Hub (spec hubs §4.9, decisão 9 do plano) pela rota real GET /hub/sync, com token de Hub, papel de
// runtime (RLS valendo) e a cripto real do Hub e do cliente.
describe('hub sync (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  const c = identityClient(() => app);
  const s = c.spaces;
  const k = hubsKit(() => app);

  let olivia: KeyedUser; // dona dos Hubs, admin da org A
  let ana: KeyedUser; // membro da org A, editora do espaço do Hub
  let bia: KeyedUser; // membro da org A
  let carl: KeyedUser; // admin das orgs C (vínculo pendente) e D (sem vínculo)

  let hub: ClaimedHub; // o Hub que sincroniza
  let other: ClaimedHub; // outro Hub da Olivia, com a Sala no mesmo espaço
  let personalOrgId: string;
  let orgA: { orgId: string; kit: { publicKey: string } };
  let orgC: string;
  let orgD: string;
  let s1: { spaceId: string; key: Uint8Array }; // no Hub, com a Sala
  let s2: string; // da org A, fora do Hub
  let cSpace: string; // da org C

  const hubToken = async (h: ClaimedHub) =>
    (await app.get(HubTokenService).issue(h.hubId)).token;
  const get = async (
    h: ClaimedHub,
    query: Record<string, string | number> = {},
  ) =>
    c
      .http()
      .get('/hub/sync')
      .query(query)
      .set({ Authorization: `Bearer ${await hubToken(h)}` });
  const sync = async (
    h: ClaimedHub,
    query: Record<string, string | number> = {},
  ): Promise<Page> => (await expectStatus(get(h, query), 200)).body as Page;
  /** Every page from `since`, following nextSince until an empty page. */
  const syncAll = async (h: ClaimedHub, limit: number, since = 0) => {
    const items: Item[] = [];
    for (let i = 0; i < 2000; i++) {
      const page = await sync(h, { since, limit });
      if (page.items.length === 0) {
        expect(page.nextSince).toBe(since);
        return { items, since };
      }
      expect(page.nextSince).toBe(page.items.at(-1)!.syncVersion);
      expect(page.nextSince).toBeGreaterThan(since);
      items.push(...page.items);
      since = page.nextSince;
    }
    throw new Error('sync did not converge');
  };
  /** The greatest syncVersion the hub would hold after a full paged sync. */
  const checkpoint = async (h: ClaimedHub) => (await syncAll(h, 500)).since;
  const ofType = (items: Item[], type: string) =>
    items.filter((i) => i.type === type);
  const ids = (items: Item[], type: string) =>
    ofType(items, type)
      .map((i) => String(i.data.id))
      .sort();
  const sorted = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    admin = await adminDataSource();
    olivia = await s.signUpKeyed('sy-olivia@example.com', 'Olivia', PASSWORD);
    ana = await s.signUpKeyed('sy-ana@example.com', 'Ana', PASSWORD);
    bia = await s.signUpKeyed('sy-bia@example.com', 'Bia', PASSWORD);
    carl = await s.signUpKeyed('sy-carl@example.com', 'Carl', PASSWORD);

    hub = await k.claim(olivia, 'Sala');
    other = await k.claim(olivia, 'Cozinha');
    const personal: { id: string }[] = await admin.query(
      `SELECT id FROM organizations WHERE personal_owner_user_id = $1`,
      [olivia.userId],
    );
    personalOrgId = personal[0]!.id;

    orgA = await s.orgWithKit(olivia, 'Org A');
    await s.joinOrg(olivia, orgA.orgId, ana);
    await s.joinOrg(olivia, orgA.orgId, bia);
    await k.link(olivia, hub.hubId, orgA.orgId);
    await k.link(olivia, other.hubId, orgA.orgId);

    const sp1 = await s.create(olivia, orgA.orgId, orgA.kit.publicKey, 'S1');
    expect(sp1.res.status).toBe(201);
    s1 = { spaceId: sp1.spaceId, key: sp1.key };
    await expectStatus(
      s.addMember(olivia.token, s1.spaceId, recipientOf(ana), [s1.key]),
      201,
    );
    await k.addSpace(olivia, hub.hubId, s1.spaceId);
    await k.addSpace(olivia, other.hubId, s1.spaceId);
    await k.grantRoom(olivia, hub, s1.spaceId, orgA.kit.publicKey, [s1.key]);
    await k.grantRoom(olivia, other, s1.spaceId, orgA.kit.publicKey, [s1.key]);
    const sp2 = await s.create(olivia, orgA.orgId, orgA.kit.publicKey, 'S2');
    expect(sp2.res.status).toBe(201);
    s2 = sp2.spaceId;

    // Org C: Olivia é membro e pede o vínculo, que fica pendente (admin_approved).
    const oc = await s.orgWithKit(carl, 'Org C');
    orgC = oc.orgId;
    await s.joinOrg(carl, orgC, olivia);
    await expectStatus(
      c
        .http()
        .patch(`/organizations/${orgC}`)
        .set(c.bearer(carl.token))
        .send({ hubLinkPolicy: 'admin_approved' }),
      200,
    );
    await expect(k.link(olivia, hub.hubId, orgC)).resolves.toMatchObject({
      status: 'pending',
    });
    const cs = await s.create(carl, orgC, oc.kit.publicKey, `C-${newId()}`);
    cSpace = cs.spaceId;
    orgD = (await s.orgWithKit(carl, 'Org D')).orgId;
  }, 180_000);
  afterAll(async () => {
    await app.close();
  });

  it('accepts only a hub token', async () => {
    await expectStatus(
      c.http().get('/hub/sync').set(c.bearer(olivia.token)),
      401,
    );
    await expectStatus(c.http().get('/hub/sync'), 401);
  });

  it('since=0 brings the whole scope, in syncVersion order, and then nothing new', async () => {
    const page = await sync(hub);
    const items = page.items;
    const versions = items.map((i) => i.syncVersion);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(page.nextSince).toBe(versions.at(-1));
    expect(new Set(items.map((i) => i.type))).toEqual(
      new Set([
        'hub',
        'hub_organization',
        'organization',
        'member',
        'role_assignment',
        'space',
        'space_key',
        'space_key_grant',
        'hub_space',
      ]),
    );
    // the only tombstone: the pending link of org C (keys only)
    expect(items.filter((i) => i.deleted)).toEqual([
      expect.objectContaining({
        type: 'hub_organization',
        data: { hubId: hub.hubId, organizationId: orgC },
      }),
    ]);

    expect(ofType(items, 'hub')).toEqual([
      expect.objectContaining({
        data: {
          id: hub.hubId,
          name: 'Sala',
          ownerUserId: olivia.userId,
          encryptionPublicKey: hub.identity.encryptionPublicKey,
          signingPublicKey: hub.identity.signingPublicKey,
        },
      }),
    ]);
    expect(
      ofType(items, 'hub_organization')
        .filter((i) => !i.deleted)
        .map((i) => i.data)
        .sort((a, b) =>
          String(a.organizationId) < String(b.organizationId) ? -1 : 1,
        ),
    ).toEqual(
      [personalOrgId, orgA.orgId].sort().map((organizationId) => ({
        hubId: hub.hubId,
        organizationId,
        status: 'approved',
      })),
    );
    expect(ids(items, 'organization')).toEqual(
      [personalOrgId, orgA.orgId].sort(),
    );
    expect(
      ofType(items, 'member')
        .map((i) => `${String(i.data.organizationId)}:${String(i.data.userId)}`)
        .sort(),
    ).toEqual(
      [
        `${personalOrgId}:${olivia.userId}`,
        `${orgA.orgId}:${olivia.userId}`,
        `${orgA.orgId}:${ana.userId}`,
        `${orgA.orgId}:${bia.userId}`,
      ].sort(),
    );
    expect(ids(items, 'space')).toEqual([s1.spaceId]);
    expect(ofType(items, 'space')[0]!.data).toMatchObject({
      organizationId: orgA.orgId,
      name: 'S1',
      currentKeyVersion: 1,
    });
    expect(ofType(items, 'space_key').map((i) => i.data)).toEqual([
      {
        id: expect.any(String),
        organizationId: orgA.orgId,
        spaceId: s1.spaceId,
        version: 1,
      },
    ]);
    expect(ofType(items, 'hub_space').map((i) => i.data)).toEqual([
      {
        hubId: hub.hubId,
        spaceId: s1.spaceId,
        organizationId: orgA.orgId,
        addedByUserId: olivia.userId,
      },
    ]);

    // Oracle (owner role, no RLS): the role rows and copies the scope defines.
    const roles: { id: string }[] = await admin.query(
      `SELECT ra.id FROM role_assignments ra
        WHERE (ra.scope_type = 'organization' AND ra.organization_id IN ($1, $2) AND ra.user_id IS NOT NULL)
           OR (ra.scope_type = 'space' AND ra.space_id = $3 AND (ra.user_id IS NOT NULL OR ra.room_hub_id = $4))
           OR (ra.scope_type = 'hub' AND ra.hub_id = $4)`,
      [personalOrgId, orgA.orgId, s1.spaceId, hub.hubId],
    );
    expect(ids(items, 'role_assignment')).toEqual(sorted(roles));
    const room = ofType(items, 'role_assignment').filter(
      (i) => i.data.roomHubId === hub.hubId,
    );
    expect(
      room
        .map((i) => `${String(i.data.scopeType)}:${String(i.data.roleKey)}`)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(['hub:hub_room', 'space:space_reader']);
    const grants: { id: string }[] = await admin.query(
      `SELECT g.id FROM space_key_grants g JOIN space_keys sk ON sk.id = g.space_key_id
        WHERE sk.space_id = $1 AND (g.user_id IS NOT NULL OR g.hub_id = $2)`,
      [s1.spaceId, hub.hubId],
    );
    expect(ids(items, 'space_key_grant')).toEqual(sorted(grants));

    const again = await sync(hub, { since: page.nextSince });
    expect(again).toEqual({ items: [], nextSince: page.nextSince });
  });

  it('a member carries the locked key material and roles, never authHash; the hub opens it with the password (offline login)', async () => {
    const { items } = await sync(hub);
    const body = JSON.stringify(items);
    expect(body).not.toMatch(/authHash|auth_hash/);
    const hashes: { auth_hash: string }[] = await admin.query(
      `SELECT auth_hash FROM users WHERE id = ANY($1)`,
      [[olivia.userId, ana.userId, bia.userId]],
    );
    for (const h of hashes) expect(body).not.toContain(h.auth_hash);
    // Nothing of the account recovery code (proof hash, sealed copy) ever reaches the hub.
    const members = ofType(items, 'member');
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) {
      expect(keysDeep(m.data).filter((key) => /recovery/i.test(key))).toEqual(
        [],
      );
    }

    const anaItem = ofType(items, 'member').find(
      (i) => i.data.userId === ana.userId,
    )!;
    expect(anaItem.data).toEqual({
      organizationId: orgA.orgId,
      userId: ana.userId,
      name: 'Ana',
      email: 'sy-ana@example.com',
      publicKey: ana.account.publicKey,
      encryptedPrivateKey: ana.account.encryptedPrivateKey,
      kdfSalt: ana.account.kdfSalt,
      kdfParams: ana.account.kdfParams,
      roles: { organization: ['org_member'], hub: 'hub_user' },
    });
    const opened = await openPrivateKey(
      PASSWORD,
      String(anaItem.data.kdfSalt),
      anaItem.data.kdfParams as typeof ana.account.kdfParams,
      String(anaItem.data.encryptedPrivateKey),
    );
    expect(
      Buffer.from(opened).equals(Buffer.from(ana.account.privateKey)),
    ).toBe(true);
    const oliviaInA = ofType(items, 'member').find(
      (i) =>
        i.data.userId === olivia.userId && i.data.organizationId === orgA.orgId,
    )!;
    expect(oliviaInA.data.roles).toEqual({
      organization: ['org_admin'],
      hub: 'hub_owner',
    });

    // An explicit hub role changes the member: it comes again with the new role.
    const { nextSince } = await sync(hub);
    await k.assignRole(olivia, hub.hubId, bia.userId, 'hub_operator');
    const next = await sync(hub, { since: nextSince });
    expect(
      ofType(next.items, 'member').map((i) => [i.data.userId, i.data.roles]),
    ).toEqual([
      [bia.userId, { organization: ['org_member'], hub: 'hub_operator' }],
    ]);
    expect(
      ofType(next.items, 'role_assignment').map((i) => [
        i.data.userId,
        i.data.roleKey,
      ]),
    ).toEqual([[bia.userId, 'hub_operator']]);
  });

  it("the hub opens its own copy of the space key; the other hub's copy never appears", async () => {
    const { items } = await sync(hub);
    const grants = ofType(items, 'space_key_grant');
    expect(grants.some((g) => g.data.hubId === other.hubId)).toBe(false);
    expect(JSON.stringify(items)).not.toContain(other.hubId);
    const own = grants.filter((g) => g.data.hubId === hub.hubId);
    expect(own).toHaveLength(1);
    expect(own[0]!.data).toMatchObject({
      spaceId: s1.spaceId,
      version: 1,
      userId: null,
    });
    const key = await k.hubOpens(hub, String(own[0]!.data.wrappedKey));
    expect(Buffer.from(key).equals(Buffer.from(s1.key))).toBe(true);

    // ...and the other hub sees its own copy, not ours.
    const theirs = ofType((await sync(other)).items, 'space_key_grant');
    expect(theirs.some((g) => g.data.hubId === hub.hubId)).toBe(false);
    expect(theirs.filter((g) => g.data.hubId === other.hubId)).toHaveLength(1);
  });

  it('an organization without an approved link never appears (pending link, unrelated org, their spaces and members)', async () => {
    const { items } = await sync(hub);
    // org C's pending link is only a tombstone with its keys (no requester, no status); nothing else of C or D
    const linkC = items.filter((i) => i.data.organizationId === orgC);
    expect(linkC).toEqual([
      {
        type: 'hub_organization',
        syncVersion: expect.any(Number),
        deleted: true,
        data: { hubId: hub.hubId, organizationId: orgC },
      },
    ]);
    const body = JSON.stringify(items.filter((i) => !linkC.includes(i)));
    for (const id of [orgC, orgD, cSpace, carl.userId]) {
      expect(body).not.toContain(id);
    }
  });

  it('a space outside hub_space never appears, nor its keys, copies or roles', async () => {
    const { items } = await sync(hub);
    const keys: { id: string }[] = await admin.query(
      `SELECT id FROM space_keys WHERE space_id = $1`,
      [s2],
    );
    const body = JSON.stringify(items);
    expect(body).not.toContain(s2);
    for (const key of keys) expect(body).not.toContain(key.id);
  });

  it('paging by nextSince never loses nor repeats an item, for any limit', async () => {
    const full = (await sync(hub)).items;
    for (const limit of [1, 2, 3, 7, 13]) {
      const { items } = await syncAll(hub, limit);
      expect(items).toEqual(full);
    }
  });

  it("a user's key change reaches every organization of the hub, and the tie is never split across pages", async () => {
    const { nextSince } = await sync(hub);
    // a password change re-wraps the private key: the same users row is behind two member items
    await admin.query(
      `UPDATE users SET encrypted_private_key = encrypted_private_key WHERE id = $1`,
      [olivia.userId],
    );
    const page = await sync(hub, { since: nextSince, limit: 1 });
    expect(
      page.items.map((i) => [i.type, i.data.organizationId, i.data.userId]),
    ).toEqual(
      [personalOrgId, orgA.orgId]
        .sort()
        .map((orgId) => ['member', orgId, olivia.userId]),
    );
    expect(new Set(page.items.map((i) => i.syncVersion)).size).toBe(1);
    expect(await sync(hub, { since: page.nextSince })).toEqual({
      items: [],
      nextSince: page.nextSince,
    });
  });

  it('limit: at most 500 per page by default, and the query is validated', async () => {
    const { nextSince } = await sync(hub);
    const key: { id: string; wrapped_key: string }[] = await admin.query(
      `SELECT sk.id, g.wrapped_key FROM space_keys sk
         JOIN space_key_grants g ON g.space_key_id = sk.id AND g.user_id = $2
        WHERE sk.space_id = $1`,
      [s1.spaceId, ana.userId],
    );
    // 520 old copies of Ana (tombstones), all in scope
    await admin.query(
      `INSERT INTO space_key_grants (organization_id, space_key_id, user_id, wrapped_key, deleted_at)
       SELECT $1, $2, $3, $4, now() FROM generate_series(1, 520)`,
      [orgA.orgId, key[0]!.id, ana.userId, key[0]!.wrapped_key],
    );
    const first = await sync(hub, { since: nextSince });
    expect(first.items).toHaveLength(500);
    const rest = await sync(hub, { since: first.nextSince });
    expect(rest.items).toHaveLength(20);
    expect(
      new Set([...first.items, ...rest.items].map((i) => i.data.id)).size,
    ).toBe(520);
    expect(
      [...first.items, ...rest.items].every(
        (i) => i.type === 'space_key_grant' && i.deleted,
      ),
    ).toBe(true);

    const invalid: Record<string, string | number>[] = [
      { limit: 501 },
      { limit: 0 },
      { limit: 'x' },
      { since: -1 },
      { since: 'abc' },
      { since: '1'.repeat(19) },
    ];
    for (const query of invalid) {
      const res = await expectStatus(get(hub, query), 422);
      expect(res.body.type).toMatch(/validation-failed$/);
    }
  });

  it('a revoked copy and a revoked role come back as tombstones, with only their key fields', async () => {
    const nextSince = await checkpoint(hub);
    const before = (await syncAll(hub, 500)).items;
    const ownCopy = ofType(before, 'space_key_grant').find(
      (g) => g.data.hubId === hub.hubId,
    )!;
    const roomRole = ofType(before, 'role_assignment').find(
      (r) => r.data.roomHubId === hub.hubId && r.data.scopeType === 'space',
    )!;

    await k.revokeRoom(olivia, hub.hubId, s1.spaceId);
    const { items } = await syncAll(hub, 500, nextSince);
    expect(items.find((i) => i.data.id === ownCopy.data.id)).toMatchObject({
      type: 'space_key_grant',
      deleted: true,
      data: { id: ownCopy.data.id },
    });
    expect(items.find((i) => i.data.id === roomRole.data.id)).toMatchObject({
      type: 'role_assignment',
      deleted: true,
      data: { id: roomRole.data.id },
    });
    // the space now needs a key rotation: the space row comes again
    expect(ofType(items, 'space')[0]!.data).toMatchObject({
      id: s1.spaceId,
      keyRotationRequired: true,
    });

    // A person's removed role/copy too: Ana leaves the space.
    const n2 = await checkpoint(hub);
    await expectStatus(
      c
        .http()
        .delete(`/spaces/${s1.spaceId}/members/${ana.userId}`)
        .set(c.bearer(olivia.token)),
      204,
    );
    const after = (await syncAll(hub, 500, n2)).items;
    const anaRows = after.filter(
      (i) =>
        (i.type === 'space_key_grant' || i.type === 'role_assignment') &&
        i.deleted,
    );
    expect(anaRows.map((i) => i.type).sort()).toEqual([
      'role_assignment',
      'space_key_grant',
    ]);
    for (const row of anaRows) expect(Object.keys(row.data)).toEqual(['id']);
  });

  it('a member who leaves the organization comes back as a tombstone (keys only), with her role and copy tombstones', async () => {
    const dan = await s.signUpKeyed('sy-dan@example.com', 'Dan', PASSWORD);
    await s.joinOrg(olivia, orgA.orgId, dan);
    await expectStatus(
      s.addMember(olivia.token, s1.spaceId, recipientOf(dan), [s1.key]),
      201,
    );
    const since = await checkpoint(hub);
    await expectStatus(
      c
        .http()
        .post(`/organizations/${orgA.orgId}/leave`)
        .set(c.bearer(dan.token)),
      204,
    );
    const { items } = await syncAll(hub, 500, since);
    expect(
      ofType(items, 'member').filter((i) => i.data.userId === dan.userId),
    ).toEqual([
      expect.objectContaining({
        deleted: true,
        data: { organizationId: orgA.orgId, userId: dan.userId },
      }),
    ]);
    const tombs: { id: string }[] = await admin.query(
      `SELECT ra.id FROM role_assignments ra
        WHERE ra.user_id = $1 AND ra.deleted_at IS NOT NULL
       UNION ALL
       SELECT g.id FROM space_key_grants g WHERE g.user_id = $1 AND g.deleted_at IS NOT NULL`,
      [dan.userId],
    );
    expect(tombs.length).toBeGreaterThanOrEqual(3); // org role, space role, copy v1
    const byId = new Map(items.map((i) => [String(i.data.id), i]));
    for (const t of tombs) {
      expect(byId.get(t.id)).toMatchObject({
        deleted: true,
        data: { id: t.id },
      });
    }
    expect(
      [...byId.values()]
        .filter((i) => tombs.some((t) => t.id === i.data.id))
        .map((i) => i.type)
        .sort(),
    ).toEqual(['role_assignment', 'role_assignment', 'space_key_grant']);
  });

  it('an unlink followed by a new request (pending, then rejected) still reaches the hub as a tombstone', async () => {
    const orgE = await s.orgWithKit(ana, 'Org E');
    await s.joinOrg(ana, orgE.orgId, olivia);
    await k.link(olivia, hub.hubId, orgE.orgId);
    const approved = await checkpoint(hub);
    const live = await syncAll(hub, 500, 0);
    expect(
      ofType(live.items, 'member').some(
        (i) => i.data.organizationId === orgE.orgId && !i.deleted,
      ),
    ).toBe(true);

    // unlink and ask again before the hub syncs: the reused row is now pending
    await expectStatus(
      c
        .http()
        .patch(`/organizations/${orgE.orgId}`)
        .set(c.bearer(ana.token))
        .send({ hubLinkPolicy: 'admin_approved' }),
      200,
    );
    await k.unlink(olivia, hub.hubId, orgE.orgId);
    await expect(k.link(olivia, hub.hubId, orgE.orgId)).resolves.toMatchObject({
      status: 'pending',
    });
    const exitE = (items: Item[]) =>
      ofType(items, 'hub_organization').filter(
        (i) => i.data.organizationId === orgE.orgId,
      );
    const pending = await syncAll(hub, 500, approved);
    expect(exitE(pending.items)).toEqual([
      expect.objectContaining({
        deleted: true,
        data: { hubId: hub.hubId, organizationId: orgE.orgId },
      }),
    ]);

    // rejected: one more tombstone, still keys only
    await k.reject(ana, hub.hubId, orgE.orgId);
    const rejected = await syncAll(hub, 500, pending.since);
    expect(exitE(rejected.items)).toEqual([
      expect.objectContaining({
        deleted: true,
        data: { hubId: hub.hubId, organizationId: orgE.orgId },
      }),
    ]);
    // and a full sync serves nothing of org E but that tombstone
    const full = (await syncAll(hub, 500)).items;
    expect(
      full.filter((i) => JSON.stringify(i.data).includes(orgE.orgId)),
    ).toEqual([
      expect.objectContaining({ type: 'hub_organization', deleted: true }),
    ]);
  });

  it('unlinking brings the link back as a tombstone, and the organization then disappears from the scope', async () => {
    const nextSince = await checkpoint(hub);
    await k.unlink(olivia, hub.hubId, orgA.orgId);
    const { items } = await syncAll(hub, 500, nextSince);
    expect(ofType(items, 'hub_organization')).toEqual([
      expect.objectContaining({
        deleted: true,
        data: { hubId: hub.hubId, organizationId: orgA.orgId },
      }),
    ]);

    // A full sync now has nothing of org A but the link tombstone (the hub cascades locally).
    const full = (await syncAll(hub, 500)).items;
    const mentionsA = full.filter((i) =>
      JSON.stringify(i.data).includes(orgA.orgId),
    );
    expect(mentionsA).toEqual([
      expect.objectContaining({ type: 'hub_organization', deleted: true }),
    ]);
    expect(JSON.stringify(full)).not.toContain(s1.spaceId);
    // the personal organization is still served
    expect(ids(full, 'organization')).toEqual([personalOrgId]);
  });
});
