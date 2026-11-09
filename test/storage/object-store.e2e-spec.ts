import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  GetBucketLifecycleConfigurationCommand,
  GetObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ObjectStore } from '../../src/storage/application/ports/object-store.js';
import { createTestApp } from '../setup/test-app.js';

// Contra o LocalStack do compose (http://aws:4566 dentro do container) ou o serviço do CI.
const BUCKET = process.env.S3_BUCKET_HUB_BRAIN!;

function rawClient(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION,
    endpoint: process.env.AWS_ENDPOINT_URL || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  });
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

function prefix(): string {
  return `orgs/${randomUUID()}/spaces/${randomUUID()}`;
}

async function upload(
  store: ObjectStore,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  const { url, headers } = await store.presignPut(key, {
    sizeBytes: bytes.length,
    sha256Hex: sha256Hex(bytes),
    expiresInSeconds: 900,
  });
  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: new Uint8Array(bytes),
  });
  expect(res.status, await res.text()).toBe(200);
}

describe('ObjectStore (S3 / LocalStack)', () => {
  let app: INestApplication;
  let store: ObjectStore;
  const s3 = rawClient();

  beforeAll(async () => {
    app = await createTestApp();
    store = app.get(ObjectStore);
  });

  afterAll(async () => {
    s3.destroy();
    await app.close();
  });

  it('accepts the declared bytes through the presigned PUT and head reports size and sha256', async () => {
    const key = `${prefix()}/uploads/${randomUUID()}`;
    const bytes = randomBytes(1024);
    await upload(store, key, bytes);

    const head = await store.head(key);
    expect(head).toEqual({
      sizeBytes: 1024,
      sha256Hex: sha256Hex(bytes),
      versionId: expect.any(String),
    });
  });

  it('tags the provisional upload with stage=upload (the 1-day lifecycle rule matches on it)', async () => {
    const key = `${prefix()}/uploads/${randomUUID()}`;
    await upload(store, key, randomBytes(16));

    const tags = await s3.send(
      new GetObjectTaggingCommand({ Bucket: BUCKET, Key: key }),
    );
    expect(tags.TagSet).toEqual([{ Key: 'stage', Value: 'upload' }]);
  });

  it('rejects bytes different from the declared ones', async () => {
    const key = `${prefix()}/uploads/${randomUUID()}`;
    const declared = randomBytes(64);
    const { url, headers } = await store.presignPut(key, {
      sizeBytes: declared.length,
      sha256Hex: sha256Hex(declared),
      expiresInSeconds: 900,
    });

    const put = (body: Uint8Array, h: Record<string, string>) =>
      fetch(url, {
        method: 'PUT',
        headers: h,
        body: new Uint8Array(body),
      }).then((r) => r.status);
    const b64 = (bytes: Uint8Array) =>
      createHash('sha256').update(bytes).digest('base64');

    // Same length, other content, signed headers untouched: S3 checks the body against the checksum (400 BadDigest).
    expect(await put(randomBytes(64), headers)).toBe(400);

    // Other content with its own checksum: the checksum header is signed (403).
    const forged = randomBytes(64);
    expect(
      await put(forged, { ...headers, 'x-amz-checksum-sha256': b64(forged) }),
    ).toBe(403);

    // Other length with consistent headers: Content-Length is signed (403).
    const longer = randomBytes(65);
    expect(
      await put(longer, {
        ...headers,
        'content-length': '65',
        'x-amz-checksum-sha256': b64(longer),
      }),
    ).toBe(403);

    // Without the checksum header or without the upload tag: both are signed (403).
    const { 'x-amz-checksum-sha256': _c, ...noChecksum } = headers;
    expect(await put(declared, noChecksum)).toBe(403);
    const { 'x-amz-tagging': _t, ...noTag } = headers;
    expect(await put(declared, noTag)).toBe(403);

    expect(await store.head(key)).toBeNull();
  });

  it('returns null from head for a missing key', async () => {
    expect(await store.head(`${prefix()}/objects/${randomUUID()}`)).toBeNull();
  });

  it('copies into a new version that keeps the sha256 and drops the upload tag', async () => {
    const base = prefix();
    const from = `${base}/uploads/${randomUUID()}`;
    const to = `${base}/objects/${randomUUID()}`;
    const bytes = randomBytes(300);
    await upload(store, from, bytes);

    const { versionId } = await store.copy(from, to);
    expect(versionId).toEqual(expect.any(String));

    expect(await store.head(to)).toEqual({
      sizeBytes: 300,
      sha256Hex: sha256Hex(bytes),
      versionId,
    });
    const tags = await s3.send(
      new GetObjectTaggingCommand({ Bucket: BUCKET, Key: to }),
    );
    expect(tags.TagSet ?? []).toEqual([]);
  });

  it('keeps every version: two copies to the same key differ and the old one stays downloadable', async () => {
    const base = prefix();
    const to = `${base}/objects/${randomUUID()}`;
    const first = randomBytes(100);
    const second = randomBytes(120);
    const fromA = `${base}/uploads/${randomUUID()}`;
    const fromB = `${base}/uploads/${randomUUID()}`;
    await upload(store, fromA, first);
    await upload(store, fromB, second);

    const v1 = await store.copy(fromA, to);
    const v2 = await store.copy(fromB, to);
    expect(v2.versionId).not.toBe(v1.versionId);

    const oldUrl = await store.presignGet(to, v1.versionId, 900);
    const old = await fetch(oldUrl);
    expect(old.status).toBe(200);
    expect(Buffer.from(await old.arrayBuffer())).toEqual(first);

    const newUrl = await store.presignGet(to, v2.versionId, 900);
    const current = await fetch(newUrl);
    expect(Buffer.from(await current.arrayBuffer())).toEqual(second);
  });

  it('deleteCurrent leaves a delete marker and the old version stays downloadable by versionId', async () => {
    const base = prefix();
    const from = `${base}/uploads/${randomUUID()}`;
    const to = `${base}/objects/${randomUUID()}`;
    const bytes = randomBytes(50);
    await upload(store, from, bytes);
    const { versionId } = await store.copy(from, to);

    const { deleteMarkerVersionId } = await store.deleteCurrent(to);
    expect(deleteMarkerVersionId).toEqual(expect.any(String));
    expect(deleteMarkerVersionId).not.toBe(versionId);
    expect(await store.head(to)).toBeNull();

    const res = await fetch(await store.presignGet(to, versionId, 900));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  it('the bucket carries the lifecycle rules of the init script', async () => {
    const lifecycle = await s3.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }),
    );
    const rules = Object.fromEntries(
      (lifecycle.Rules ?? []).map((r) => [r.ID, r]),
    );
    expect(rules['objects-versions-30d']).toMatchObject({
      Status: 'Enabled',
      Filter: { Prefix: 'orgs/' },
      Expiration: { ExpiredObjectDeleteMarker: true },
      NoncurrentVersionExpiration: { NoncurrentDays: 30 },
    });
    expect(rules['uploads-1d']).toMatchObject({
      Status: 'Enabled',
      Filter: {
        And: { Prefix: 'orgs/', Tags: [{ Key: 'stage', Value: 'upload' }] },
      },
      Expiration: { Days: 1 },
      NoncurrentVersionExpiration: { NoncurrentDays: 1 },
    });
  });
});
