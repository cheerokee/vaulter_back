import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type request from 'supertest';
import { newId } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { hubClient } from '../support/hub-client.js';
import {
  openBackupObject,
  sealBackupObject,
  sha256Hex,
} from '../support/hub-crypto.js';
import { hubsKit, type ClaimedHub } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
  recipientOf,
} from '../support/identity-client.js';

const GiB = 1024 ** 3;

function expectProblem(
  res: request.Response,
  status: number,
  type: string,
): Record<string, unknown> {
  if (res.status !== status) {
    throw new Error(
      `expected ${status} ${type}, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.type).toMatch(new RegExp(`/${type}$`));
  return res.body as Record<string, unknown>;
}

type Intent = {
  objectId: string;
  uploadId: string;
  url: string;
  headers: Record<string, string>;
};

type ListedVersion = {
  versionId: string;
  keyVersion: number;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
};

type ListedObject = {
  objectId: string;
  deleted: boolean;
  deletedAt: string | null;
  currentVersion: ListedVersion | null;
};

type Space = { spaceId: string; key: Uint8Array };

// Listar o índice e baixar (spec storage-backup §4.3) pela HTTP real, com a cifra real do Hub (sealBackupObject /
// openBackupObject), o LocalStack do compose e o papel de runtime (RLS valendo). "Restaurar = reinstalar": um Hub
// reivindicado depois, posto na Sala, baixa e abre com a chave que recebeu pela sincronização. Review Focus 4.
describe('storage downloads and trash (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const kit = hubsKit(() => app);
  const as = (u: KeyedUser) => c.bearer(u.token);

  let olivia: KeyedUser; // dona dos Hubs, admin e Gestora dos espaços
  let ana: KeyedUser; // space_editor
  let rita: KeyedUser; // space_reader
  let zeca: KeyedUser; // membro da organização, fora do espaço
  let nina: KeyedUser; // fora da organização
  let orgId: string;
  let kitPublicKey: string;

  const newSpace = async (name: string): Promise<Space> => {
    const sp = await s.create(olivia, orgId, kitPublicKey, name, {
      storageQuotaBytes: 2 * GiB,
    });
    await expectStatus(Promise.resolve(sp.res), 201);
    for (const [u, role] of [
      [ana, 'space_editor'],
      [rita, 'space_reader'],
    ] as const) {
      await expectStatus(
        s.addMember(olivia.token, sp.spaceId, recipientOf(u), [sp.key], role),
        201,
      );
    }
    return { spaceId: sp.spaceId, key: sp.key };
  };

  /** A new hub of olivia, linked to the organization (approved: she is the admin). */
  const linkedHub = async (name: string): Promise<ClaimedHub> => {
    const hub = await h.onboard(olivia.token, name);
    await expectStatus(
      c
        .http()
        .post(`/hubs/${hub.hubId}/organizations`)
        .set(as(olivia))
        .send({ organizationId: orgId }),
      201,
    );
    return hub;
  };

  /** Installs the space on the hub and opens it in its Room. */
  const putInRoom = async (
    hub: ClaimedHub,
    space: Space,
    roleKey: 'space_reader' | 'space_editor',
  ) => {
    await expectStatus(
      c
        .http()
        .post(`/hubs/${hub.hubId}/spaces`)
        .set(as(olivia))
        .send({ spaceId: space.spaceId }),
      201,
    );
    await kit.grantRoom(
      olivia,
      hub,
      space.spaceId,
      kitPublicKey,
      [space.key],
      roleKey,
    );
  };

  // Token first: a supertest request created before another one finishes loses its server address.
  const hubGet = async (
    hub: ClaimedHub,
    path: string,
    query: Record<string, string | number> = {},
  ) => {
    const token = await h.authenticate(hub);
    return c.http().get(path).query(query).set(h.bearer(token));
  };
  const hubPost = async (hub: ClaimedHub, path: string, body: object = {}) => {
    const token = await h.authenticate(hub);
    return c.http().post(path).set(h.bearer(token)).send(body);
  };
  const userGet = (
    token: string,
    path: string,
    query: Record<string, string | number> = {},
  ) => c.http().get(path).query(query).set(c.bearer(token));
  const userPost = (token: string, path: string, body: object = {}) =>
    c.http().post(path).set(c.bearer(token)).send(body);

  /**
   * Uploads `plaintext` as a new version of `objectId` (sealed with the space key) with the user token of olivia
   * (Gestora: memory.write) and returns the committed version id.
   */
  const upload = async (
    space: Space,
    objectId: string,
    plaintext: Uint8Array,
    replacesVersionId: string | null = null,
    via: { hub: ClaimedHub } | { token: string } = { token: olivia.token },
  ): Promise<string> => {
    const blob = await sealBackupObject(
      space.key,
      { spaceId: space.spaceId, objectId, keyVersion: 1 },
      plaintext,
    );
    const item = {
      objectId,
      keyVersion: 1,
      sizeBytes: blob.length,
      sha256: await sha256Hex(blob),
      replacesVersionId,
    };
    const base =
      'hub' in via
        ? `/hub/spaces/${space.spaceId}`
        : `/spaces/${space.spaceId}/backup`;
    const post = (path: string, body: object) =>
      'hub' in via
        ? hubPost(via.hub, `${base}${path}`, body)
        : userPost(via.token, `${base}${path}`, body);
    const intent = await expectStatus(post('/uploads', { items: [item] }), 201);
    const [i] = intent.body.items as Intent[];
    const put = await fetch(i!.url, {
      method: 'PUT',
      headers: i!.headers,
      body: new Uint8Array(blob),
    });
    expect(put.status, await put.text()).toBe(200);
    await expectStatus(
      post('/uploads/confirm', { uploadIds: [i!.uploadId] }),
      200,
    );
    return i!.uploadId;
  };

  /** Downloads through the presigned URL and opens with the space key. */
  const fetchAndOpen = async (
    url: string,
    key: Uint8Array,
    spaceId: string,
    objectId: string,
  ): Promise<Buffer> => {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const blob = new Uint8Array(await res.arrayBuffer());
    return Buffer.from(
      await openBackupObject(key, { spaceId, objectId, keyVersion: 1 }, blob),
    );
  };

  /** Every page of a listing, following `nextCursor`. */
  const listAll = async <T>(
    get: (query: Record<string, string | number>) => Promise<request.Response>,
    query: Record<string, string | number> = {},
  ): Promise<T[]> => {
    const items: T[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const res = await expectStatus(
        get(cursor ? { ...query, cursor } : query),
        200,
      );
      items.push(...(res.body.items as T[]));
      cursor = res.body.nextCursor as string | null;
      if (!cursor) return items;
    }
    throw new Error('listAll: too many pages');
  };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    rita = await s.signUpKeyed('rita@example.com', 'Rita');
    zeca = await s.signUpKeyed('zeca@example.com', 'Zeca');
    nina = await s.signUpKeyed('nina@example.com', 'Nina');
    const o = await s.orgWithKit(olivia, 'Backup');
    orgId = o.orgId;
    kitPublicKey = o.kit.publicKey;
    for (const u of [ana, rita, zeca]) await s.joinOrg(olivia, orgId, u);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('restore = reinstall: hub A uploads, a hub claimed later is put in the Room, lists, downloads and opens with the key it received', async () => {
    const space = await newSpace('Restore');
    const hubA = await linkedHub('Hub A');
    await putInRoom(hubA, space, 'space_editor');
    const files = [randomBytes(300), randomBytes(700), randomBytes(50)];
    const objectIds = files.map(() => newId()).sort();
    const versionIds: string[] = [];
    for (const [i, objectId] of objectIds.entries()) {
      versionIds.push(
        await upload(space, objectId, files[i]!, null, { hub: hubA }),
      );
    }
    // An intent that was never confirmed is not a live object.
    const ghost = newId();
    await expectStatus(
      hubPost(hubA, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [
          {
            objectId: ghost,
            keyVersion: 1,
            sizeBytes: 100,
            sha256: 'a'.repeat(64),
            replacesVersionId: null,
          },
        ],
      }),
      201,
    );

    // Hub A burns: a new hub is claimed, linked, gets the space in its Room (reader is enough to read).
    const hubB = await linkedHub('Hub B');
    await putInRoom(hubB, space, 'space_reader');

    // The key comes through the sync (its own sealed copy), never from the backend in clear.
    const tokenB = await h.authenticate(hubB);
    const { items: synced } = await h.syncAll(tokenB);
    const grant = synced.find(
      (i) =>
        i.type === 'space_key_grant' &&
        i.data.spaceId === space.spaceId &&
        i.data.hubId === hubB.hubId &&
        i.data.version === 1,
    );
    expect(grant).toBeDefined();
    const key = await kit.hubOpens(hubB, grant!.data.wrappedKey as string);
    expect(Buffer.from(key)).toEqual(Buffer.from(space.key));

    // Lists every page (limit 2: two pages) and downloads each current version by its presigned URL.
    const listed = await listAll<ListedObject>(
      (q) => hubGet(hubB, `/hub/spaces/${space.spaceId}/objects`, q),
      { limit: 2 },
    );
    expect(listed).toEqual(
      objectIds.map((objectId, i) => ({
        objectId,
        deleted: false,
        deletedAt: null,
        currentVersion: {
          versionId: versionIds[i],
          keyVersion: 1,
          sizeBytes: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          uploadedAt: expect.any(String),
        },
      })),
    );
    expect(listed.map((o) => o.objectId)).not.toContain(ghost);
    for (const [i, o] of listed.entries()) {
      const res = await expectStatus(
        hubPost(
          hubB,
          `/hub/spaces/${space.spaceId}/objects/${o.objectId}/versions/${o.currentVersion!.versionId}/download`,
        ),
        200,
      );
      const expiresIn = Date.parse(res.body.expiresAt) - Date.now();
      expect(expiresIn).toBeGreaterThan(14 * 60_000);
      expect(expiresIn).toBeLessThanOrEqual(15 * 60_000);
      expect(
        await fetchAndOpen(res.body.url, key, space.spaceId, o.objectId),
      ).toEqual(files[i]);
    }
  }, 60_000);

  it('a person logged in through a hub downloads a space that is not in that hub Room; the hub itself gets 404', async () => {
    const space = await newSpace('Outside Room');
    const objectId = newId();
    const plaintext = randomBytes(200);
    const versionId = await upload(space, objectId, plaintext);
    const hub = await linkedHub('Hub Pessoa');
    const hubToken = await h.authenticate(hub);
    const login = await expectStatus(
      h.loginPerson(hubToken, rita.email, rita.account.authProof),
      200,
    );
    const ritaOnHub = login.body.session.accessToken as string;

    const list = await expectStatus(
      userGet(ritaOnHub, `/spaces/${space.spaceId}/backup/objects`),
      200,
    );
    expect(list.body.items).toEqual([
      expect.objectContaining({
        objectId,
        currentVersion: expect.objectContaining({ versionId }),
      }),
    ]);
    const dl = await expectStatus(
      userPost(
        ritaOnHub,
        `/spaces/${space.spaceId}/backup/objects/${objectId}/versions/${versionId}/download`,
      ),
      200,
    );
    expect(
      await fetchAndOpen(dl.body.url, space.key, space.spaceId, objectId),
    ).toEqual(plaintext);

    expectProblem(
      await hubGet(hub, `/hub/spaces/${space.spaceId}/objects`),
      404,
      'space-not-found',
    );
    expectProblem(
      await hubPost(
        hub,
        `/hub/spaces/${space.spaceId}/objects/${objectId}/versions/${versionId}/download`,
      ),
      404,
      'space-not-found',
    );
  }, 60_000);

  it('the trash shows the deleted object and old versions; they download and open; out of the 30 days they are 404', async () => {
    const space = await newSpace('Trash');
    const base = `/spaces/${space.spaceId}/backup`;
    const a = newId();
    const b = newId();
    const a1 = randomBytes(120);
    const a2 = randomBytes(130);
    const b1 = randomBytes(140);
    const va1 = await upload(space, a, a1);
    const va2 = await upload(space, a, a2, va1);
    const vb1 = await upload(space, b, b1);
    const before = await expectStatus(
      userGet(olivia.token, `${base}/objects`),
      200,
    );
    const asOf = before.body.asOf as string;
    expect(Number.isNaN(Date.parse(asOf))).toBe(false);
    await expectStatus(
      userPost(olivia.token, `${base}/objects/delete`, {
        items: [{ objectId: b, replacesVersionId: vb1 }],
      }),
      204,
    );

    // current: only the live object, with its new version
    const current = await expectStatus(
      userGet(rita.token, `${base}/objects`),
      200,
    );
    expect(current.body.items).toEqual([
      expect.objectContaining({
        objectId: a,
        deleted: false,
        currentVersion: expect.objectContaining({ versionId: va2 }),
      }),
    ]);

    // since: what changed after asOf, tombstones included (no current version)
    const delta = await expectStatus(
      userGet(rita.token, `${base}/objects`, { since: asOf }),
      200,
    );
    expect(delta.body.items).toEqual([
      {
        objectId: b,
        deleted: true,
        deletedAt: expect.any(String),
        currentVersion: null,
      },
    ]);

    // trash: the deleted object with its last version, which downloads and opens
    const trash = await expectStatus(
      userGet(rita.token, `${base}/objects`, { include: 'trash' }),
      200,
    );
    expect(trash.body.items).toEqual([
      expect.objectContaining({
        objectId: b,
        deleted: true,
        deletedAt: expect.any(String),
        currentVersion: expect.objectContaining({ versionId: vb1 }),
      }),
    ]);
    const dlB = await expectStatus(
      userPost(rita.token, `${base}/objects/${b}/versions/${vb1}/download`),
      200,
    );
    expect(
      await fetchAndOpen(dlB.body.url, space.key, space.spaceId, b),
    ).toEqual(b1);

    // versions: the old one (superseded) and the current, oldest first; the old one downloads and opens
    const versions = await expectStatus(
      userGet(rita.token, `${base}/objects`, {
        include: 'versions',
        objectId: a,
      }),
      200,
    );
    expect(versions.body.items).toEqual([
      {
        objectId: a,
        versionId: va1,
        keyVersion: 1,
        sizeBytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        uploadedAt: expect.any(String),
        supersededAt: expect.any(String),
        current: false,
      },
      expect.objectContaining({
        versionId: va2,
        supersededAt: null,
        current: true,
      }),
    ]);
    const dlA1 = await expectStatus(
      userPost(rita.token, `${base}/objects/${a}/versions/${va1}/download`),
      200,
    );
    expect(
      await fetchAndOpen(dlA1.body.url, space.key, space.spaceId, a),
    ).toEqual(a1);

    // 31 days later (moved back in the index, DB clock): out of the trash, 404 and no longer listed
    const admin = await adminDataSource();
    await admin.query(
      `UPDATE storage_object_versions SET superseded_at = now() - interval '31 days' WHERE id = ANY($1::uuid[])`,
      [[va1, vb1]],
    );
    await admin.query(
      `UPDATE storage_objects SET deleted_at = now() - interval '31 days' WHERE id = $1`,
      [b],
    );
    for (const [objectId, versionId] of [
      [a, va1],
      [b, vb1],
    ]) {
      expectProblem(
        await userPost(
          rita.token,
          `${base}/objects/${objectId}/versions/${versionId}/download`,
        ),
        404,
        'version-not-found',
      );
    }
    const trashLater = await expectStatus(
      userGet(rita.token, `${base}/objects`, { include: 'trash' }),
      200,
    );
    expect(trashLater.body.items).toEqual([]);
    const versionsLater = await expectStatus(
      userGet(rita.token, `${base}/objects`, {
        include: 'versions',
        objectId: a,
      }),
      200,
    );
    expect(
      (versionsLater.body.items as { versionId: string }[]).map(
        (v) => v.versionId,
      ),
    ).toEqual([va2]);
  }, 60_000);

  it('Review Focus 4: a hub taken out of the Room (or unlinked) keeps only its 15-min URL; new listings and URLs are 404', async () => {
    const space = await newSpace('Focus 4');
    const objectId = newId();
    const plaintext = randomBytes(90);
    const versionId = await upload(space, objectId, plaintext);
    const path = `/hub/spaces/${space.spaceId}/objects/${objectId}/versions/${versionId}/download`;

    const roomOut = await linkedHub('Hub Room Out');
    await putInRoom(roomOut, space, 'space_reader');
    const unlinked = await linkedHub('Hub Unlinked');
    await putInRoom(unlinked, space, 'space_reader');

    const urls: string[] = [];
    for (const hub of [roomOut, unlinked]) {
      await expectStatus(
        hubGet(hub, `/hub/spaces/${space.spaceId}/objects`),
        200,
      );
      const dl = await expectStatus(hubPost(hub, path), 200);
      // The URL itself lives 15 min (S3 enforces it), no longer.
      expect(new URL(dl.body.url).searchParams.get('X-Amz-Expires')).toBe(
        '900',
      );
      urls.push(dl.body.url as string);
    }

    await kit.revokeRoom(olivia, roomOut.hubId, space.spaceId);
    await kit.unlink(olivia, unlinked.hubId, orgId);

    for (const [i, hub] of [roomOut, unlinked].entries()) {
      expectProblem(
        await hubGet(hub, `/hub/spaces/${space.spaceId}/objects`),
        404,
        'space-not-found',
      );
      expectProblem(
        await hubGet(hub, `/hub/spaces/${space.spaceId}/objects`, {
          include: 'trash',
        }),
        404,
        'space-not-found',
      );
      expectProblem(await hubPost(hub, path), 404, 'space-not-found');
      // The URL already handed out still works until it expires.
      expect(
        await fetchAndOpen(urls[i]!, space.key, space.spaceId, objectId),
      ).toEqual(plaintext);
    }
  }, 60_000);

  it('non-members are 404 (never 403), a reader reads; unknown, pending or foreign versions are 404; the query is validated', async () => {
    const space = await newSpace('Who');
    const other = await newSpace('Other');
    const base = `/spaces/${space.spaceId}/backup`;
    const objectId = newId();
    const versionId = await upload(space, objectId, randomBytes(64));
    const otherObject = newId();
    const otherVersion = await upload(other, otherObject, randomBytes(64));
    const dl = (o: string, v: string) =>
      `${base}/objects/${o}/versions/${v}/download`;

    for (const u of [zeca, nina]) {
      expectProblem(
        await userGet(u.token, `${base}/objects`),
        404,
        'space-not-found',
      );
      expectProblem(
        await userPost(u.token, dl(objectId, versionId)),
        404,
        'space-not-found',
      );
    }
    for (const u of [rita, ana, olivia]) {
      await expectStatus(userGet(u.token, `${base}/objects`), 200);
      await expectStatus(userPost(u.token, dl(objectId, versionId)), 200);
    }

    // A pending intent (never confirmed) has no version to download.
    const pending = await expectStatus(
      userPost(olivia.token, `${base}/uploads`, {
        items: [
          {
            objectId,
            keyVersion: 1,
            sizeBytes: 10,
            sha256: 'b'.repeat(64),
            replacesVersionId: versionId,
          },
        ],
      }),
      201,
    );
    const pendingId = (pending.body.items as Intent[])[0]!.uploadId;
    for (const [o, v] of [
      [objectId, newId()], // unknown version
      [objectId, pendingId], // pending
      [otherObject, otherVersion], // another space's object
      [newId(), versionId], // the version under another object id
    ]) {
      expectProblem(
        await userPost(rita.token, dl(o!, v!)),
        404,
        'version-not-found',
      );
    }

    const badQueries: Record<string, string | number>[] = [
      { include: 'versions' }, // objectId required
      { include: 'everything' },
      { since: 'yesterday' },
      { limit: 0 },
      { limit: 1001 },
      { objectId: 'not-a-uuid', include: 'versions' },
      { objectId, include: 'current' }, // objectId only with versions
      { since: new Date().toISOString(), include: 'versions', objectId }, // since not with versions
      { cursor: '!!!' },
    ];
    for (const query of badQueries) {
      const res = await userGet(rita.token, `${base}/objects`, query);
      expect(res.status, JSON.stringify(query)).toBe(422);
    }
    expectProblem(
      await userPost(rita.token, dl('nope', versionId)),
      422,
      'validation-failed',
    );
  }, 60_000);
});
