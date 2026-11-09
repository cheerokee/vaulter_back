import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import { MAX_OBJECT_BYTES, UPLOAD_WINDOW_MS } from './backup-limits.js';
import { objectKey, uploadKey } from './backup-keys.js';
import { BackupObject } from './backup-object.js';
import { BackupObjectVersion } from './backup-object-version.js';
import { BackupRules } from './backup-rules.js';

const NOW = new Date('2026-11-09T12:00:00Z');
const ORG = '01900000-0000-7000-8000-000000000001';
const SPACE = '01900000-0000-7000-8000-000000000002';
const OBJ = '01900000-0000-7000-8000-000000000003';
const V1 = '01900000-0000-7000-8000-0000000000a1';
const V2 = '01900000-0000-7000-8000-0000000000a2';
const SHA = 'a'.repeat(64);

const object = (
  currentVersionId: string | null,
  deletedAt: Date | null = null,
) =>
  BackupObject.restore({
    id: OBJ,
    organizationId: ORG,
    spaceId: SPACE,
    currentVersionId,
    deletedAt,
  });

const request = (
  over: Partial<Parameters<typeof BackupObjectVersion.request>[0]> = {},
) =>
  BackupObjectVersion.request({
    id: V2,
    organizationId: ORG,
    spaceId: SPACE,
    objectId: OBJ,
    keyVersion: 1,
    sizeBytes: 100,
    sha256: SHA,
    replacesVersionId: null,
    uploader: { hubId: 'h' },
    now: NOW,
    ...over,
  });

describe('bucket keys', () => {
  it('only ids, under the organization and the space', () => {
    expect(uploadKey(ORG, SPACE, V1)).toBe(
      `orgs/${ORG}/spaces/${SPACE}/uploads/${V1}`,
    );
    expect(objectKey(ORG, SPACE, OBJ)).toBe(
      `orgs/${ORG}/spaces/${SPACE}/objects/${OBJ}`,
    );
  });
});

describe('BackupRules', () => {
  const space = {
    keyRotationRequired: false,
    currentKeyVersion: 3,
    storageQuotaBytes: 1000,
  };

  it('pending rotation: 409 space-key-rotation-required; other version: 409 space-key-version-stale', () => {
    expect(() =>
      BackupRules.assertWritable({ ...space, keyRotationRequired: true }, 3),
    ).toThrow(
      expect.objectContaining({
        constructor: ConflictError,
        code: 'space-key-rotation-required',
      }),
    );
    expect(() => BackupRules.assertWritable(space, 2)).toThrow(
      expect.objectContaining({
        code: 'space-key-version-stale',
        details: { currentKeyVersion: 3 },
      }),
    );
    expect(() => BackupRules.assertWritable(space, 3)).not.toThrow();
  });

  it('the space must fit usage + the new objects: 422 space-storage-full with what is missing', () => {
    expect(() => BackupRules.assertFits(space, 900, 100)).not.toThrow();
    expect(() => BackupRules.assertFits(space, 900, 150)).toThrow(
      expect.objectContaining({
        constructor: DomainValidationError,
        code: 'space-storage-full',
        details: { missingBytes: 50 },
      }),
    );
  });

  it('an object above 5 GiB is 422 object-too-large; duplicates are refused', () => {
    expect(() =>
      BackupRules.assertObjectSize(OBJ, MAX_OBJECT_BYTES),
    ).not.toThrow();
    expect(() =>
      BackupRules.assertObjectSize(OBJ, MAX_OBJECT_BYTES + 1),
    ).toThrow(expect.objectContaining({ code: 'object-too-large' }));
    expect(() => BackupRules.assertDistinctObjects([OBJ, OBJ])).toThrow(
      expect.objectContaining({ code: 'duplicate-object' }),
    );
  });
});

describe('BackupObject', () => {
  it('a write must replace the live version (null for a new or deleted object)', () => {
    expect(() => object(null).assertReplaces(null)).not.toThrow();
    expect(() => object(V1).assertReplaces(V1)).not.toThrow();
    expect(() => object(V1, NOW).assertReplaces(null)).not.toThrow();
    for (const [o, replaces] of [
      [object(V1), null],
      [object(null), V1],
      [object(V1), V2],
      [object(V1, NOW), V1],
    ] as const) {
      expect(() => o.assertReplaces(replaces)).toThrow(
        expect.objectContaining({
          constructor: ConflictError,
          code: 'object-version-conflict',
        }),
      );
    }
  });

  it('commit makes the version current, revives a deleted object and returns what it superseded', () => {
    const o = object(V1);
    expect(o.commit(V2)).toEqual({ supersededVersionId: V1 });
    expect(o.liveVersionId).toBe(V2);
    const deleted = object(V1, NOW);
    expect(deleted.commit(V2)).toEqual({ supersededVersionId: null });
    expect(deleted.deletedAt).toBeNull();
  });

  it('delete tombstones the live version; again with the same version is unchanged; otherwise a conflict', () => {
    const o = object(V1);
    expect(o.delete(V1, NOW)).toEqual({
      outcome: 'deleted',
      supersededVersionId: V1,
    });
    expect(o.deletedAt).toEqual(NOW);
    expect(o.currentVersionId).toBe(V1);
    expect(o.delete(V1, NOW)).toEqual({ outcome: 'unchanged' });
    expect(() => object(V1).delete(V2, NOW)).toThrow(
      expect.objectContaining({ code: 'object-version-conflict' }),
    );
    expect(() => object(null).delete(V1, NOW)).toThrow(
      expect.objectContaining({ code: 'object-version-conflict' }),
    );
  });
});

describe('BackupObjectVersion', () => {
  it('an intent is pending and reserves until the upload window ends', () => {
    const v = request();
    expect(v.status).toBe('pending');
    expect(v.uploadExpiresAt).toEqual(
      new Date(NOW.getTime() + UPLOAD_WINDOW_MS),
    );
    expect(v.isConfirmable(NOW)).toBe(true);
    expect(v.isConfirmable(v.uploadExpiresAt)).toBe(false);
  });

  it('refuses objects above 5 GiB at the intent', () => {
    expect(() => request({ sizeBytes: MAX_OBJECT_BYTES + 1 })).toThrow(
      expect.objectContaining({ code: 'object-too-large' }),
    );
  });

  it('the uploaded blob must match exactly; missing, zero size or no checksum is a mismatch', () => {
    const v = request();
    expect(() =>
      v.assertUploaded({ sizeBytes: 100, sha256Hex: SHA }),
    ).not.toThrow();
    for (const blob of [
      null,
      { sizeBytes: 0, sha256Hex: SHA },
      { sizeBytes: 100, sha256Hex: null },
      { sizeBytes: 99, sha256Hex: SHA },
      { sizeBytes: 100, sha256Hex: 'b'.repeat(64) },
    ]) {
      expect(() => v.assertUploaded(blob)).toThrow(
        expect.objectContaining({
          constructor: DomainValidationError,
          code: 'upload-mismatch',
        }),
      );
    }
  });

  it('commit records the S3 version and the time; only once', () => {
    const v = request();
    v.commit('s3v', NOW);
    expect(v.status).toBe('committed');
    expect(v.s3VersionId).toBe('s3v');
    expect(v.committedAt).toEqual(NOW);
    expect(v.isConfirmable(NOW)).toBe(false);
    expect(() => v.commit('again', NOW)).toThrow();
  });
});
