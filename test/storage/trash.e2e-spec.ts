import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type request from 'supertest';
import { newId } from '../../src/shared/domain/id.js';
import { ObjectStore } from '../../src/storage/application/ports/object-store.js';
import { objectKey } from '../../src/storage/domain/backup-keys.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  openBackupObject,
  sealBackupObject,
  sha256Hex,
} from '../support/hub-crypto.js';
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
): void {
  if (res.status !== status) {
    throw new Error(
      `expected ${status} ${type}, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.type).toMatch(new RegExp(`/${type}$`));
}

type Space = { spaceId: string; key: Uint8Array };
type Uploaded = { versionId: string; sizeBytes: number; plaintext: Buffer };

// Controle da lixeira (spec storage-backup §4.8, decisão do Jonas de 2026-11-09) pela HTTP real, com a cifra real do
// cliente, o LocalStack do compose e o papel de runtime (RLS valendo): limite de 10 versões antigas por objeto,
// esvaziar a lixeira (Gestor, com reautenticação) e o `trashBytes` do GET do espaço.
describe('storage trash controls (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;

  let olivia: KeyedUser; // admin e Gestora dos espaços
  let ana: KeyedUser; // space_editor
  let zeca: KeyedUser; // membro da organização, fora do espaço
  let orgId: string;
  let kitPublicKey: string;

  const newSpace = async (name: string): Promise<Space> => {
    const sp = await s.create(olivia, orgId, kitPublicKey, name, {
      storageQuotaBytes: 1 * GiB,
    });
    await expectStatus(Promise.resolve(sp.res), 201);
    await expectStatus(
      s.addMember(
        olivia.token,
        sp.spaceId,
        recipientOf(ana),
        [sp.key],
        'space_editor',
      ),
      201,
    );
    return { spaceId: sp.spaceId, key: sp.key };
  };

  const post = (token: string, path: string, body: object = {}) =>
    c.http().post(path).set(c.bearer(token)).send(body);
  const get = (
    token: string,
    path: string,
    query: Record<string, string | number> = {},
  ) => c.http().get(path).query(query).set(c.bearer(token));

  /** A new version of `objectId` (sealed with the space key), uploaded and confirmed with olivia's token. */
  const upload = async (
    space: Space,
    objectId: string,
    replacesVersionId: string | null,
  ): Promise<Uploaded> => {
    const plaintext = randomBytes(100 + Math.floor(Math.random() * 400));
    const blob = await sealBackupObject(
      space.key,
      { spaceId: space.spaceId, objectId, keyVersion: 1 },
      plaintext,
    );
    const base = `/spaces/${space.spaceId}/backup`;
    const intent = await expectStatus(
      post(olivia.token, `${base}/uploads`, {
        items: [
          {
            objectId,
            keyVersion: 1,
            sizeBytes: blob.length,
            sha256: await sha256Hex(blob),
            replacesVersionId,
          },
        ],
      }),
      201,
    );
    const [i] = intent.body.items as {
      uploadId: string;
      url: string;
      headers: Record<string, string>;
    }[];
    const put = await fetch(i!.url, {
      method: 'PUT',
      headers: i!.headers,
      body: new Uint8Array(blob),
    });
    expect(put.status, await put.text()).toBe(200);
    await expectStatus(
      post(olivia.token, `${base}/uploads/confirm`, {
        uploadIds: [i!.uploadId],
      }),
      200,
    );
    return { versionId: i!.uploadId, sizeBytes: blob.length, plaintext };
  };

  const chain = async (space: Space, objectId: string, n: number) => {
    const out: Uploaded[] = [];
    for (let k = 0; k < n; k++) {
      out.push(await upload(space, objectId, out.at(-1)?.versionId ?? null));
    }
    return out;
  };

  const download = (space: Space, objectId: string, versionId: string) =>
    post(
      olivia.token,
      `/spaces/${space.spaceId}/backup/objects/${objectId}/versions/${versionId}/download`,
    );

  const storageOf = async (space: Space) =>
    (await expectStatus(get(olivia.token, `/spaces/${space.spaceId}`), 200))
      .body.storage as {
      quotaBytes: number;
      usedBytes: number;
      trashBytes: number;
    };

  const sum = (xs: readonly Uploaded[]) =>
    xs.reduce((total, x) => total + x.sizeBytes, 0);

  const s3VersionIds = async (versionIds: readonly string[]) => {
    const admin = await adminDataSource();
    const rows: { id: string; s3_version_id: string }[] = await admin.query(
      `SELECT id, s3_version_id FROM storage_object_versions WHERE id = ANY($1::uuid[])`,
      [versionIds],
    );
    return new Map(rows.map((r) => [r.id, r.s3_version_id]));
  };

  const bucketVersions = (space: Space, objectId: string) =>
    app
      .get(ObjectStore)
      .listVersions(objectKey(orgId, space.spaceId, objectId));

  const emptyTrash = (token: string, space: Space, currentAuthProof: string) =>
    post(token, `/spaces/${space.spaceId}/backup/trash/empty`, {
      currentAuthProof,
    });

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    zeca = await s.signUpKeyed('zeca@example.com', 'Zeca');
    const o = await s.orgWithKit(olivia, 'Trash');
    orgId = o.orgId;
    kitPublicKey = o.kit.publicKey;
    for (const u of [ana, zeca]) await s.joinOrg(olivia, orgId, u);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('12 versions of one object: only the 10 newest old versions stay (listing, usage, download, bucket)', async () => {
    const space = await newSpace('Cap');
    const objectId = newId();
    const versions = await chain(space, objectId, 12);
    const [purged, ...kept] = versions; // v0 is beyond the cap: 11 old versions -> the oldest goes
    const listed = await expectStatus(
      get(olivia.token, `/spaces/${space.spaceId}/backup/objects`, {
        include: 'versions',
        objectId,
      }),
      200,
    );
    const items = listed.body.items as {
      versionId: string;
      current: boolean;
    }[];
    expect(items.map((i) => i.versionId)).toEqual(kept.map((v) => v.versionId));
    expect(items.filter((i) => !i.current)).toHaveLength(10);

    const storage = await storageOf(space);
    expect(storage.usedBytes).toBe(sum(kept));
    expect(storage.trashBytes).toBe(sum(kept.slice(0, 10)));

    expectProblem(
      await download(space, objectId, purged!.versionId),
      404,
      'version-not-found',
    );
    await expectStatus(download(space, objectId, kept[0]!.versionId), 200);

    // In the index: `purged`, with the database clock; in the bucket: gone (deleted after the COMMIT).
    const admin = await adminDataSource();
    const [row] = (await admin.query(
      `SELECT status, purged_at FROM storage_object_versions WHERE id = $1`,
      [purged!.versionId],
    )) as { status: string; purged_at: Date | null }[];
    expect(row).toMatchObject({
      status: 'purged',
      purged_at: expect.any(Date),
    });
    const s3 = await s3VersionIds(versions.map((v) => v.versionId));
    const inBucket = (await bucketVersions(space, objectId)).map(
      (v) => v.versionId,
    );
    expect(inBucket).not.toContain(s3.get(purged!.versionId));
    expect(inBucket.sort()).toEqual(
      kept.map((v) => s3.get(v.versionId)!).sort(),
    );
  }, 120_000);

  it('the Gestor empties the trash: trash 0, usage = live versions only, the live version still opens with the key', async () => {
    const space = await newSpace('Empty');
    const live = newId();
    const gone = newId();
    const a = await chain(space, live, 3); // 2 old versions in the trash
    const b = await chain(space, gone, 2); // 1 old version...
    await expectStatus(
      post(olivia.token, `/spaces/${space.spaceId}/backup/objects/delete`, {
        items: [{ objectId: gone, replacesVersionId: b[1]!.versionId }],
      }),
      204,
    ); // ...and the deleted one: 2 versions of a tombstone in the trash
    const before = await storageOf(space);
    const trashBytes = sum(a.slice(0, 2)) + sum(b);
    expect(before).toMatchObject({
      usedBytes: sum(a) + sum(b),
      trashBytes,
    });

    // Not the Gestor: 403; outside the space: 404; wrong proof: 422 and nothing purged.
    expectProblem(
      await emptyTrash(ana.token, space, ana.account.authProof),
      403,
      'permission-denied',
    );
    expectProblem(
      await emptyTrash(zeca.token, space, zeca.account.authProof),
      404,
      'space-not-found',
    );
    expectProblem(
      await emptyTrash(olivia.token, space, ana.account.authProof),
      422,
      'current-auth-proof-invalid',
    );
    expect(await storageOf(space)).toEqual(before);
    const admin = await adminDataSource();
    const purgedCount = async () =>
      (
        (await admin.query(
          `SELECT count(*)::int AS n FROM storage_object_versions WHERE space_id = $1 AND status = 'purged'`,
          [space.spaceId],
        )) as { n: number }[]
      )[0]!.n;
    expect(await purgedCount()).toBe(0);

    const res = await expectStatus(
      emptyTrash(olivia.token, space, olivia.account.authProof),
      200,
    );
    expect(res.body).toEqual({
      purgedVersions: 4,
      purgedBytes: trashBytes,
      remainingVersions: 0,
    });
    expect(await purgedCount()).toBe(4);
    expect(await storageOf(space)).toEqual({
      quotaBytes: 1 * GiB,
      usedBytes: a[2]!.sizeBytes,
      trashBytes: 0,
    });

    // The live version still downloads and opens with the real space key; the old ones are 404.
    const url = (
      await expectStatus(download(space, live, a[2]!.versionId), 200)
    ).body.url as string;
    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);
    const opened = await openBackupObject(
      space.key,
      { spaceId: space.spaceId, objectId: live, keyVersion: 1 },
      new Uint8Array(await fetched.arrayBuffer()),
    );
    expect(Buffer.from(opened)).toEqual(a[2]!.plaintext);
    for (const [objectId, v] of [
      [live, a[0]!],
      [live, a[1]!],
      [gone, b[0]!],
      [gone, b[1]!],
    ] as const) {
      expectProblem(
        await download(space, objectId, v.versionId),
        404,
        'version-not-found',
      );
    }

    // The trash listing is empty; an incremental listing still shows the tombstone (without a version).
    const base = `/spaces/${space.spaceId}/backup/objects`;
    const trash = await expectStatus(
      get(olivia.token, base, { include: 'trash' }),
      200,
    );
    expect(trash.body.items).toEqual([]);
    const since = await expectStatus(
      get(olivia.token, base, {
        include: 'current',
        since: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
      200,
    );
    expect(since.body.items).toContainEqual(
      expect.objectContaining({
        objectId: gone,
        deleted: true,
        currentVersion: null,
      }),
    );

    // Bucket: the live object keeps only its live version; the deleted one keeps only its delete marker.
    const s3 = await s3VersionIds([a[2]!.versionId]);
    expect((await bucketVersions(space, live)).map((v) => v.versionId)).toEqual(
      [s3.get(a[2]!.versionId)],
    );
    const goneInBucket = await bucketVersions(space, gone);
    expect(goneInBucket.every((v) => v.isDeleteMarker)).toBe(true);
    expect(goneInBucket).toHaveLength(1);

    // Audit in the organization (actor = the Gestor; no secret, no proof).
    const audit: { user_id: string; metadata: Record<string, unknown> }[] =
      await admin.query(
        `SELECT user_id, metadata FROM audit_logs WHERE organization_id = $1 AND action = 'space.backup.trash_emptied'`,
        [orgId],
      );
    expect(audit).toEqual([
      {
        user_id: olivia.userId,
        metadata: {
          spaceId: space.spaceId,
          purgedVersions: 4,
          purgedBytes: trashBytes,
        },
      },
    ]);

    // Nothing left: zeros, no new audit row.
    expect(
      (
        await expectStatus(
          emptyTrash(olivia.token, space, olivia.account.authProof),
          200,
        )
      ).body,
    ).toEqual({ purgedVersions: 0, purgedBytes: 0, remainingVersions: 0 });
  }, 120_000);

  it('a malformed proof or a malformed space id is 422 before anything else', async () => {
    const space = await newSpace('Malformed');
    expectProblem(
      await emptyTrash(olivia.token, space, 'not base64url!'),
      422,
      'validation-failed',
    );
    expectProblem(
      await post(olivia.token, `/spaces/not-a-uuid/backup/trash/empty`, {
        currentAuthProof: olivia.account.authProof,
      }),
      422,
      'validation-failed',
    );
  });
});
