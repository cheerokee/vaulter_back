import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type request from 'supertest';
import { newId } from '../../src/shared/domain/id.js';
import { ObjectStore } from '../../src/storage/application/ports/object-store.js';
import { ReconcileStorageUseCase } from '../../src/storage/application/reconcile-storage.use-case.js';
import { BackupObjectRepository } from '../../src/storage/domain/backup-object.repository.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { generateSpaceKey } from '../support/client-crypto.js';
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
const BUCKET = process.env.S3_BUCKET_HUB_BRAIN!;

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
  expiresAt: string;
};

/** What the hub does with a presigned PUT: the exact bytes and the returned headers, verbatim. */
async function put(intent: Intent, blob: Uint8Array): Promise<void> {
  const res = await fetch(intent.url, {
    method: 'PUT',
    headers: intent.headers,
    body: new Uint8Array(blob),
  });
  expect(res.status, await res.text()).toBe(200);
}

async function versionRows(objectId: string) {
  const ds = await adminDataSource();
  return (await ds.query(
    `SELECT id, status, s3_version_id, superseded_at, size_bytes, uploaded_by_hub_id, uploaded_by_user_id
       FROM storage_object_versions WHERE object_id = $1 ORDER BY created_at, id`,
    [objectId],
  )) as {
    id: string;
    status: string;
    s3_version_id: string | null;
    superseded_at: Date | null;
    size_bytes: string;
    uploaded_by_hub_id: string | null;
    uploaded_by_user_id: string | null;
  }[];
}

async function objectRow(objectId: string) {
  const ds = await adminDataSource();
  const rows = (await ds.query(
    `SELECT current_version_id, deleted_at FROM storage_objects WHERE id = $1`,
    [objectId],
  )) as { current_version_id: string | null; deleted_at: Date | null }[];
  return rows[0] ?? null;
}

// Índice e envio do backup (spec storage-backup §4.2) pela HTTP real, com a cifra real do Hub (sealBackupObject),
// o LocalStack do compose e o papel de runtime (RLS valendo). Review Focus 1–3 do plano.
describe('storage uploads (e2e)', () => {
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
  let orgId: string;
  let kitPublicKey: string;

  type Space = { spaceId: string; key: Uint8Array };

  // 2 GiB each: the organization's 50 GiB fit every space of the suite.
  const newSpace = async (name: string, storageQuotaBytes = 2 * GiB) => {
    const sp = await s.create(olivia, orgId, kitPublicKey, name, {
      storageQuotaBytes,
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
    return { spaceId: sp.spaceId, key: sp.key } as Space;
  };

  /** A hub of olivia, linked to the organization, with the space installed and open in its Room. */
  const roomHub = async (
    space: Space,
    roleKey: 'space_reader' | 'space_editor',
    hub?: ClaimedHub,
  ): Promise<ClaimedHub> => {
    const claimed = hub ?? (await h.onboard(olivia.token, `Hub ${roleKey}`));
    if (!hub) {
      await expectStatus(
        c
          .http()
          .post(`/hubs/${claimed.hubId}/organizations`)
          .set(as(olivia))
          .send({ organizationId: orgId }),
        201,
      );
    }
    await expectStatus(
      c
        .http()
        .post(`/hubs/${claimed.hubId}/spaces`)
        .set(as(olivia))
        .send({ spaceId: space.spaceId }),
      201,
    );
    await kit.grantRoom(
      olivia,
      claimed,
      space.spaceId,
      kitPublicKey,
      [space.key],
      roleKey,
    );
    return claimed;
  };

  // Token first: a supertest request created before another one finishes loses its server address.
  const hubPost = async (hub: ClaimedHub, path: string, body: object) => {
    const token = await h.authenticate(hub);
    return c.http().post(path).set(h.bearer(token)).send(body);
  };
  const userPost = (u: KeyedUser, path: string, body: object) =>
    c.http().post(path).set(as(u)).send(body);

  /** A sealed blob of a fresh object, with its declaration. */
  const blobFor = async (
    space: Space,
    plaintext = randomBytes(300),
    objectId = newId(),
    keyVersion = 1,
    key = space.key,
  ) => {
    const blob = await sealBackupObject(
      key,
      { spaceId: space.spaceId, objectId, keyVersion },
      plaintext,
    );
    return {
      objectId,
      blob,
      plaintext,
      item: {
        objectId,
        keyVersion,
        sizeBytes: blob.length,
        sha256: await sha256Hex(blob),
        replacesVersionId: null as string | null,
      },
    };
  };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    rita = await s.signUpKeyed('rita@example.com', 'Rita');
    zeca = await s.signUpKeyed('zeca@example.com', 'Zeca');
    const o = await s.orgWithKit(olivia, 'Backup');
    orgId = o.orgId;
    kitPublicKey = o.kit.publicKey;
    for (const u of [ana, rita, zeca]) await s.joinOrg(olivia, orgId, u);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('a Room editor hub uploads real ciphertext: intent, PUT to S3, confirm; the copy opens with the space key', async () => {
    const space = await newSpace('Docs');
    const hub = await roomHub(space, 'space_editor');
    const obj = await blobFor(space);

    const intent = await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [obj.item],
      }),
      201,
    );
    const [it1] = intent.body.items as Intent[];
    expect(it1).toMatchObject({ objectId: obj.objectId });
    expect(it1!.url).toContain(
      `orgs/${orgId}/spaces/${space.spaceId}/uploads/${it1!.uploadId}`,
    );
    expect(it1!.headers['x-amz-tagging']).toBe('stage=upload');
    expect(Date.parse(it1!.expiresAt) - Date.now()).toBeLessThanOrEqual(
      15 * 60_000,
    );
    // The reservation counts in the usage right away.
    const reserved = await expectStatus(
      c.http().get(`/spaces/${space.spaceId}`).set(as(olivia)),
      200,
    );
    expect(reserved.body.storage.usedBytes).toBe(obj.item.sizeBytes);

    await put(it1!, obj.blob);
    const confirmed = await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
        uploadIds: [it1!.uploadId],
      }),
      200,
    );
    expect(confirmed.body.items).toEqual([
      {
        uploadId: it1!.uploadId,
        versionId: it1!.uploadId,
        objectId: obj.objectId,
        keyVersion: 1,
        sizeBytes: obj.item.sizeBytes,
        sha256: obj.item.sha256,
        uploadedAt: expect.any(String),
      },
    ]);
    const [row] = await versionRows(obj.objectId);
    expect(row).toMatchObject({
      id: it1!.uploadId,
      status: 'committed',
      uploaded_by_hub_id: hub.hubId,
      uploaded_by_user_id: null,
    });
    expect(await objectRow(obj.objectId)).toEqual({
      current_version_id: it1!.uploadId,
      deleted_at: null,
    });

    // The committed copy is in objects/<objectId>, as that S3 version, and opens with the space key.
    const store = app.get(ObjectStore);
    const key = `orgs/${orgId}/spaces/${space.spaceId}/objects/${obj.objectId}`;
    expect(await store.head(key)).toEqual({
      sizeBytes: obj.item.sizeBytes,
      sha256Hex: obj.item.sha256,
      versionId: row!.s3_version_id,
    });
    const res = await fetch(
      await store.presignGet(key, row!.s3_version_id!, 60),
    );
    const opened = await openBackupObject(
      space.key,
      { spaceId: space.spaceId, objectId: obj.objectId, keyVersion: 1 },
      new Uint8Array(await res.arrayBuffer()),
    );
    expect(Buffer.from(opened)).toEqual(obj.plaintext);

    // Review Focus 2: the hub confirms again after a timeout: same answer, one version, no second copy.
    const again = await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
        uploadIds: [it1!.uploadId],
      }),
      200,
    );
    expect(again.body).toEqual(confirmed.body);
    expect(await versionRows(obj.objectId)).toHaveLength(1);
    expect((await store.head(key))!.versionId).toBe(row!.s3_version_id);

    // A new version replaces the current one, which goes to the trash (still counted in the usage).
    const v2 = await blobFor(space, randomBytes(500), obj.objectId);
    const intent2 = await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [{ ...v2.item, replacesVersionId: it1!.uploadId }],
      }),
      201,
    );
    const [it2] = intent2.body.items as Intent[];
    await put(it2!, v2.blob);
    await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
        uploadIds: [it2!.uploadId],
      }),
      200,
    );
    const rows = await versionRows(obj.objectId);
    expect(rows.map((r) => [r.status, r.superseded_at !== null])).toEqual([
      ['committed', true],
      ['committed', false],
    ]);
    const used = await expectStatus(
      c.http().get(`/spaces/${space.spaceId}`).set(as(olivia)),
      200,
    );
    expect(used.body.storage.usedBytes).toBe(
      obj.item.sizeBytes + v2.item.sizeBytes,
    );
  });

  it('Review Focus 1: a provisional object different from the declaration is 422 upload-mismatch; nothing enters the index', async () => {
    const space = await newSpace('Mismatch');
    const hub = await roomHub(space, 'space_editor');
    const obj = await blobFor(space);
    const intent = await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [obj.item],
      }),
      201,
    );
    const [it1] = intent.body.items as Intent[];
    const confirm = () =>
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
        uploadIds: [it1!.uploadId],
      });

    // Nothing uploaded yet.
    expect(
      expectProblem(await confirm(), 422, 'upload-mismatch'),
    ).toMatchObject({ uploadId: it1!.uploadId });

    // Other bytes written at the provisional key behind the presigned URL's back (the URL itself refuses them).
    const raw = new S3Client({
      region: process.env.AWS_REGION,
      endpoint: process.env.AWS_ENDPOINT_URL || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    });
    try {
      await raw.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: `orgs/${orgId}/spaces/${space.spaceId}/uploads/${it1!.uploadId}`,
          Body: randomBytes(obj.item.sizeBytes + 1),
          ChecksumAlgorithm: 'SHA256',
        }),
      );
    } finally {
      raw.destroy();
    }
    expectProblem(await confirm(), 422, 'upload-mismatch');

    expect((await versionRows(obj.objectId)).map((r) => r.status)).toEqual([
      'pending',
    ]);
    expect(await objectRow(obj.objectId)).toEqual({
      current_version_id: null,
      deleted_at: null,
    });
    expect(
      await app
        .get(ObjectStore)
        .head(`orgs/${orgId}/spaces/${space.spaceId}/objects/${obj.objectId}`),
    ).toBeNull();
  });

  it('Review Focus 3: a rotation that becomes pending between intent and confirm refuses both (409); after the rotation the old key version is stale (409)', async () => {
    const space = await newSpace('Rotation');
    const hub = await roomHub(space, 'space_editor');
    const obj = await blobFor(space);
    const intent = await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [obj.item],
      }),
      201,
    );
    const [it1] = intent.body.items as Intent[];
    await put(it1!, obj.blob);

    // Rita leaves the space: the key must be rotated.
    await expectStatus(
      c
        .http()
        .delete(`/spaces/${space.spaceId}/members/${rita.userId}`)
        .set(as(olivia)),
      204,
    );
    expectProblem(
      await hubPost(hub, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
        uploadIds: [it1!.uploadId],
      }),
      409,
      'space-key-rotation-required',
    );
    expect(await objectRow(obj.objectId)).toMatchObject({
      current_version_id: null,
    });
    const another = await blobFor(space);
    expectProblem(
      await hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [another.item],
      }),
      409,
      'space-key-rotation-required',
    );

    const v2 = await generateSpaceKey();
    await expectStatus(
      s.rotate(olivia.token, space.spaceId, {
        version: 2,
        key: v2,
        recipients: await s.memberRecipients(olivia.token, space.spaceId),
        kitPublicKey,
      }),
      201,
    );
    expect(
      expectProblem(
        await hubPost(hub, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
          uploadIds: [it1!.uploadId],
        }),
        409,
        'space-key-version-stale',
      ),
    ).toMatchObject({ currentKeyVersion: 2 });
    expectProblem(
      await hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [another.item],
      }),
      409,
      'space-key-version-stale',
    );
    // With the new version it works.
    const fresh = await blobFor(space, randomBytes(64), newId(), 2, v2);
    await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [fresh.item],
      }),
      201,
    );
  });

  it('two hubs replacing the same version: the second confirmation is 409 object-version-conflict', async () => {
    const space = await newSpace('Conflict');
    const one = await roomHub(space, 'space_editor');
    const two = await roomHub(space, 'space_editor');
    const objectId = newId();
    const a = await blobFor(space, randomBytes(100), objectId);
    const b = await blobFor(space, randomBytes(120), objectId);

    const intentA = (
      await expectStatus(
        hubPost(one, `/hub/spaces/${space.spaceId}/uploads`, {
          items: [a.item],
        }),
        201,
      )
    ).body.items[0] as Intent;
    const intentB = (
      await expectStatus(
        hubPost(two, `/hub/spaces/${space.spaceId}/uploads`, {
          items: [b.item],
        }),
        201,
      )
    ).body.items[0] as Intent;
    await put(intentA, a.blob);
    await put(intentB, b.blob);

    await expectStatus(
      hubPost(one, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
        uploadIds: [intentA.uploadId],
      }),
      200,
    );
    expect(
      expectProblem(
        await hubPost(two, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
          uploadIds: [intentB.uploadId],
        }),
        409,
        'object-version-conflict',
      ),
    ).toMatchObject({ objectId, currentVersionId: intentA.uploadId });
    expect(await objectRow(objectId)).toMatchObject({
      current_version_id: intentA.uploadId,
    });
    // At the intent too, once the first one is committed.
    expectProblem(
      await hubPost(two, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [b.item],
      }),
      409,
      'object-version-conflict',
    );
  });

  it('a full space is 422 with what is missing; an object above 5 GiB is 422 object-too-large', async () => {
    const space = await newSpace('Small', GiB);
    const hub = await roomHub(space, 'space_editor');
    const item = (sizeBytes: number) => ({
      objectId: newId(),
      keyVersion: 1,
      sizeBytes,
      sha256: 'a'.repeat(64),
      replacesVersionId: null,
    });
    expect(
      expectProblem(
        await hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
          items: [item(GiB / 2), item(GiB / 2 + 100)],
        }),
        422,
        'space-storage-full',
      ),
    ).toMatchObject({ missingBytes: 100 });
    // All or nothing: nothing was reserved.
    const view = await expectStatus(
      c.http().get(`/spaces/${space.spaceId}`).set(as(olivia)),
      200,
    );
    expect(view.body.storage.usedBytes).toBe(0);

    expectProblem(
      await hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [item(5 * GiB + 1)],
      }),
      422,
      'object-too-large',
    );

    // The reservation is real usage: the space cannot shrink below it.
    await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [item(GiB - 10)],
      }),
      201,
    );
    expectProblem(
      await hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [item(11)],
      }),
      422,
      'space-storage-full',
    );
  });

  it('a reader Room, a hub outside the Room and a hub deleting are 404 space-not-found (never 403)', async () => {
    const space = await newSpace('Readers');
    const reader = await roomHub(space, 'space_reader');
    const editor = await roomHub(space, 'space_editor');
    const outsider = await h.onboard(olivia.token, 'Fora');
    const obj = await blobFor(space);

    expectProblem(
      await hubPost(reader, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [obj.item],
      }),
      404,
      'space-not-found',
    );
    expectProblem(
      await hubPost(outsider, `/hub/spaces/${space.spaceId}/uploads`, {
        items: [obj.item],
      }),
      404,
      'space-not-found',
    );
    expectProblem(
      await hubPost(editor, `/hub/spaces/${space.spaceId}/objects/delete`, {
        items: [{ objectId: obj.objectId, replacesVersionId: newId() }],
      }),
      404,
      'space-not-found',
    );
    expectProblem(
      await hubPost(editor, `/hub/spaces/${newId()}/uploads`, {
        items: [obj.item],
      }),
      404,
      'space-not-found',
    );
    // A user token on a hub route and a hub token on a user route: 401.
    expect(
      (
        await userPost(ana, `/hub/spaces/${space.spaceId}/uploads`, {
          items: [obj.item],
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await hubPost(editor, `/spaces/${space.spaceId}/backup/uploads`, {
          items: [obj.item],
        })
      ).status,
    ).toBe(401);
  });

  it('a person uploads with a user token (editor), a reader gets 403, a non-member 404; only the manager deletes', async () => {
    const space = await newSpace('People');
    const obj = await blobFor(space);
    const base = `/spaces/${space.spaceId}/backup`;

    expectProblem(
      await userPost(rita, `${base}/uploads`, { items: [obj.item] }),
      403,
      'permission-denied',
    );
    expectProblem(
      await userPost(zeca, `${base}/uploads`, { items: [obj.item] }),
      404,
      'space-not-found',
    );

    const intent = await expectStatus(
      userPost(ana, `${base}/uploads`, { items: [obj.item] }),
      201,
    );
    const [it1] = intent.body.items as Intent[];
    await put(it1!, obj.blob);
    await expectStatus(
      userPost(ana, `${base}/uploads/confirm`, { uploadIds: [it1!.uploadId] }),
      200,
    );
    expect((await versionRows(obj.objectId))[0]).toMatchObject({
      uploaded_by_hub_id: null,
      uploaded_by_user_id: ana.userId,
    });

    const del = {
      items: [{ objectId: obj.objectId, replacesVersionId: it1!.uploadId }],
    };
    expectProblem(
      await userPost(ana, `${base}/objects/delete`, del),
      403,
      'permission-denied',
    );
    expectProblem(
      await userPost(olivia, `${base}/objects/delete`, {
        items: [{ objectId: obj.objectId, replacesVersionId: newId() }],
      }),
      409,
      'object-version-conflict',
    );
    await expectStatus(userPost(olivia, `${base}/objects/delete`, del), 204);
    const row = await objectRow(obj.objectId);
    expect(row!.deleted_at).not.toBeNull();
    expect(row!.current_version_id).toBe(it1!.uploadId);
    expect((await versionRows(obj.objectId))[0]!.superseded_at).not.toBeNull();
    const store = app.get(ObjectStore);
    const key = `orgs/${orgId}/spaces/${space.spaceId}/objects/${obj.objectId}`;
    expect(await store.head(key)).toBeNull();
    // Deleting again is a no-op; the trash still counts in the usage.
    await expectStatus(userPost(olivia, `${base}/objects/delete`, del), 204);
    const view = await expectStatus(
      c.http().get(`/spaces/${space.spaceId}`).set(as(olivia)),
      200,
    );
    expect(view.body.storage.usedBytes).toBe(obj.item.sizeBytes);

    // A deleted object comes back with replacesVersionId = null.
    const back = await blobFor(space, randomBytes(80), obj.objectId);
    const intent2 = await expectStatus(
      userPost(olivia, `${base}/uploads`, { items: [back.item] }),
      201,
    );
    const [it2] = intent2.body.items as Intent[];
    await put(it2!, back.blob);
    await expectStatus(
      userPost(olivia, `${base}/uploads/confirm`, {
        uploadIds: [it2!.uploadId],
      }),
      200,
    );
    expect(await objectRow(obj.objectId)).toEqual({
      current_version_id: it2!.uploadId,
      deleted_at: null,
    });
  });

  it('upload ids of another space or unknown are 404 upload-not-found; the body is validated (422)', async () => {
    const space = await newSpace('Ids');
    const other = await newSpace('Other');
    const obj = await blobFor(other);
    const intent = await expectStatus(
      userPost(ana, `/spaces/${other.spaceId}/backup/uploads`, {
        items: [obj.item],
      }),
      201,
    );
    const [it1] = intent.body.items as Intent[];
    expectProblem(
      await userPost(ana, `/spaces/${space.spaceId}/backup/uploads/confirm`, {
        uploadIds: [it1!.uploadId],
      }),
      404,
      'upload-not-found',
    );
    for (const body of [
      { items: [] },
      { items: [{ ...obj.item, replacesVersionId: undefined }] },
      { items: [{ ...obj.item, sha256: 'A'.repeat(64) }] },
      { items: [{ ...obj.item, name: 'secret.pdf' }] },
      { items: Array.from({ length: 101 }, () => obj.item) },
    ]) {
      expectProblem(
        await userPost(ana, `/spaces/${space.spaceId}/backup/uploads`, body),
        422,
        'validation-failed',
      );
    }
    expectProblem(
      await userPost(ana, `/spaces/${space.spaceId}/backup/uploads`, {
        items: [obj.item, obj.item],
      }),
      422,
      'duplicate-object',
    );
  });

  it('a crash between the S3 write and the COMMIT is repaired: the reconcile sweep (runtime role, RLS) removes what the index does not reference', async () => {
    const space = await newSpace('Repair');
    const hub = await roomHub(space, 'space_editor');
    const obj = await blobFor(space);
    const [it1] = (
      await expectStatus(
        hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
          items: [obj.item],
        }),
        201,
      )
    ).body.items as Intent[];
    await put(it1!, obj.blob);
    await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
        uploadIds: [it1!.uploadId],
      }),
      200,
    );
    const committedS3 = (await versionRows(obj.objectId))[0]!.s3_version_id!;

    // What a crashed confirmation leaves: a marked pending version and a newer S3 version at objects/<objectId>.
    const v2 = await blobFor(space, randomBytes(90), obj.objectId);
    const [it2] = (
      await expectStatus(
        hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
          items: [{ ...v2.item, replacesVersionId: it1!.uploadId }],
        }),
        201,
      )
    ).body.items as Intent[];
    await put(it2!, v2.blob);
    const store = app.get(ObjectStore);
    const key = `orgs/${orgId}/spaces/${space.spaceId}/objects/${obj.objectId}`;
    const stray = await store.copy(
      `orgs/${orgId}/spaces/${space.spaceId}/uploads/${it2!.uploadId}`,
      key,
    );
    const ds = await adminDataSource();
    await ds.query(
      `UPDATE storage_object_versions SET s3_write_started_at = now() - interval '2 hours' WHERE id = $1`,
      [it2!.uploadId],
    );
    expect((await store.head(key))!.versionId).toBe(stray.versionId);

    const result = await app.get(ReconcileStorageUseCase).execute();
    expect(result).toEqual({ objects: 1, removedVersions: 1 });
    expect((await store.head(key))!.versionId).toBe(committedS3);
    // The sweep cleared the aged mark it repaired; the fresh mark of the committed version stays (never cleared on
    // commit; a later sweep clears it once it is old).
    const marked = (await ds.query(
      `SELECT id FROM storage_object_versions WHERE object_id = $1 AND s3_write_started_at IS NOT NULL`,
      [obj.objectId],
    )) as { id: string }[];
    expect(marked.map((r) => r.id)).toEqual([it1!.uploadId]);
    // Nothing left to repair; the pending version can still be confirmed normally.
    expect(await app.get(ReconcileStorageUseCase).execute()).toEqual({
      objects: 0,
      removedVersions: 0,
    });
    await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
        uploadIds: [it2!.uploadId],
      }),
      200,
    );
  });

  it('the journal mark is written before the confirmation transaction and survives its rollback (runtime role, RLS)', async () => {
    const space = await newSpace('Journal');
    const hub = await roomHub(space, 'space_editor');
    const obj = await blobFor(space);
    const [it1] = (
      await expectStatus(
        hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
          items: [obj.item],
        }),
        201,
      )
    ).body.items as Intent[];
    const markOf = async (id: string) => {
      const ds = await adminDataSource();
      const rows = (await ds.query(
        `SELECT s3_write_started_at FROM storage_object_versions WHERE id = $1`,
        [id],
      )) as { s3_write_started_at: Date | null }[];
      return rows[0]!.s3_write_started_at;
    };
    expect(await markOf(it1!.uploadId)).toBeNull();

    // Not uploaded yet: the confirmation's unit of work rolls back with 422, the mark (written before it) stays.
    expectProblem(
      await hubPost(hub, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
        uploadIds: [it1!.uploadId],
      }),
      422,
      'upload-mismatch',
    );
    const first = await markOf(it1!.uploadId);
    expect(first).toBeInstanceOf(Date);

    // The mark is the DATABASE clock, refreshed by every attempt and never cleared on commit.
    const ds = await adminDataSource();
    const [{ fresh }] = (await ds.query(
      `SELECT s3_write_started_at BETWEEN now() - interval '1 minute' AND now() AS fresh
         FROM storage_object_versions WHERE id = $1`,
      [it1!.uploadId],
    )) as { fresh: boolean }[];
    expect(fresh).toBe(true);
    await put(it1!, obj.blob);
    await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
        uploadIds: [it1!.uploadId],
      }),
      200,
    );
    const second = await markOf(it1!.uploadId);
    expect(second!.getTime()).toBeGreaterThanOrEqual(first!.getTime());
  });

  it('a sweep clearing the mark between the journal and the main transaction: 409 storage-busy and no unmarked S3 write', async () => {
    const space = await newSpace('Busy');
    const hub = await roomHub(space, 'space_editor');
    const obj = await blobFor(space);
    const [it1] = (
      await expectStatus(
        hubPost(hub, `/hub/spaces/${space.spaceId}/uploads`, {
          items: [obj.item],
        }),
        201,
      )
    ).body.items as Intent[];
    await put(it1!, obj.blob);

    // The sweep runs right after the journal transaction committed, before the object lock.
    const repo = app.get(BackupObjectRepository);
    const original = repo.lockForUpdate.bind(repo);
    const ds = await adminDataSource();
    const spy = vi
      .spyOn(repo, 'lockForUpdate')
      .mockImplementationOnce(async (...args) => {
        await ds.query(
          `UPDATE storage_object_versions SET s3_write_started_at = NULL WHERE id = $1`,
          [it1!.uploadId],
        );
        return original(...args);
      });
    try {
      expectProblem(
        await hubPost(hub, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
          uploadIds: [it1!.uploadId],
        }),
        409,
        'storage-busy',
      );
    } finally {
      spy.mockRestore();
    }
    const key = `orgs/${orgId}/spaces/${space.spaceId}/objects/${obj.objectId}`;
    expect(await app.get(ObjectStore).listVersions(key)).toEqual([]);
    expect(await objectRow(obj.objectId)).toMatchObject({
      current_version_id: null,
    });
    // Retryable: the next attempt marks again and commits.
    await expectStatus(
      hubPost(hub, `/hub/spaces/${space.spaceId}/uploads/confirm`, {
        uploadIds: [it1!.uploadId],
      }),
      200,
    );
  });

  it('the index never has a name, type or path column: only ids, sizes, hashes, versions, uploader and dates', async () => {
    const ds = await adminDataSource();
    const columns = async (table: string) =>
      (
        (await ds.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
          [table],
        )) as { column_name: string }[]
      ).map((r) => r.column_name);
    expect(await columns('storage_objects')).toEqual(
      [
        'created_at',
        'current_version_id',
        'deleted_at',
        'id',
        'organization_id',
        'space_id',
        'updated_at',
      ].sort(),
    );
    expect(await columns('storage_object_versions')).toEqual(
      [
        'committed_at',
        'created_at',
        'deleted_at',
        'id',
        'key_version',
        'object_id',
        'organization_id',
        'replaces_version_id',
        's3_version_id',
        'sha256',
        'size_bytes',
        'space_id',
        'status',
        'superseded_at',
        'updated_at',
        'upload_expires_at',
        'uploaded_by_hub_id',
        'uploaded_by_user_id',
        's3_write_started_at',
      ].sort(),
    );
  });
});
