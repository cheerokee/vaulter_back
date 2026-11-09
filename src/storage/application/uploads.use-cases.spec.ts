import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from '../../shared/domain/errors.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { BackupObject } from '../domain/backup-object.js';
import type { BackupObjectRepository } from '../domain/backup-object.repository.js';
import { BackupObjectVersion } from '../domain/backup-object-version.js';
import type { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { MAX_OBJECT_BYTES } from '../domain/backup-limits.js';
import { BackupObjectHealer } from './backup-object-healer.js';
import { ConfirmUploadsUseCase } from './confirm-uploads.use-case.js';
import { DeleteObjectsUseCase } from './delete-objects.use-case.js';
import type { ObjectStore } from './ports/object-store.js';
import { ReconcileStorageUseCase } from './reconcile-storage.use-case.js';
import { RequestUploadsUseCase } from './request-uploads.use-case.js';
import type { StorageAccess } from './storage-access.js';

const NOW = new Date('2026-11-09T12:00:00Z');
const ORG = '01900000-0000-7000-8000-000000000001';
const SPACE = '01900000-0000-7000-8000-000000000002';
const OBJ_A = '01900000-0000-7000-8000-00000000000a';
const OBJ_B = '01900000-0000-7000-8000-00000000000b';
const HUB = { hubId: '01900000-0000-7000-8000-0000000000b1' };
const SHA = 'c'.repeat(64);
const GiB = 1024 ** 3;

// In-memory doubles of the contracts (the use cases only see them). The unit of work keeps copies of the rows and
// restores them when `work` throws (a real rollback); `commitThenReject` keeps them and rejects anyway (a COMMIT the
// server applied but whose answer was lost). Write marks written through `detached` survive a rollback, like the
// autocommitted statement. The bucket is a list of versions per key.
function setup() {
  const trace: string[] = [];
  const state = {
    keyRotationRequired: false,
    currentKeyVersion: 2,
    storageQuotaBytes: 10 * GiB,
  };
  let objects = new Map<string, BackupObject>();
  let versions = new Map<string, BackupObjectVersion>();
  let marks = new Set<string>();
  const foreignObjects = new Set<string>();
  const bucket = new Map<
    string,
    { versionId: string; isDeleteMarker: boolean }[]
  >();
  let usedBytes = 0;
  let s3 = 0;
  let mode: 'normal' | 'commitThenReject' = 'normal';
  const heads = new Map<
    string,
    { sizeBytes: number; sha256Hex: string | null } | null
  >();
  const versionsOf = (key: string) => {
    if (!bucket.has(key)) bucket.set(key, []);
    return bucket.get(key)!;
  };

  const access = {
    lock: vi.fn(
      async (
        _spaceId: string,
        _actor: unknown,
        permission: string,
        lockMode: string,
      ) => {
        trace.push(`lock:${permission}:${lockMode}`);
        return { organizationId: ORG, spaceId: SPACE, ...state };
      },
    ),
  };
  const objectRepo = {
    lockOrCreate: vi.fn(async (_o: string, _s: string, id: string) => {
      trace.push(`lockOrCreate:${id}`);
      if (foreignObjects.has(id)) return null;
      if (!objects.has(id)) {
        objects.set(
          id,
          BackupObject.restore({
            id,
            organizationId: ORG,
            spaceId: SPACE,
            currentVersionId: null,
            deletedAt: null,
          }),
        );
      }
      return cloneObject(objects.get(id)!);
    }),
    lockForUpdate: vi.fn(async (_o: string, _s: string, id: string) => {
      trace.push(`lockObject:${id}`);
      const o = objects.get(id);
      return o ? cloneObject(o) : null;
    }),
    save: vi.fn(async (o: BackupObject) => {
      trace.push(`saveObject:${o.id}`);
      objects.set(o.id, cloneObject(o));
    }),
  };
  const versionRepo = {
    create: vi.fn(async (v: BackupObjectVersion) => {
      trace.push(`createVersion:${v.objectId}`);
      versions.set(v.id, cloneVersion(v));
    }),
    save: vi.fn(async (v: BackupObjectVersion) => {
      trace.push(`saveVersion:${v.id}`);
      versions.set(v.id, cloneVersion(v));
    }),
    findByIds: vi.fn(async (_o: string, _s: string, ids: readonly string[]) =>
      ids
        .filter((id) => versions.has(id))
        .map((id) => cloneVersion(versions.get(id)!)),
    ),
    expirePending: vi.fn(async (_o: string, _s: string, objectId: string) => {
      trace.push(`expirePending:${objectId}`);
      return 0;
    }),
    markSuperseded: vi.fn(async (_o: string, ids: readonly string[]) => {
      trace.push(`superseded:${ids.join(',')}`);
    }),
    usedBytes: vi.fn(async () => {
      trace.push('usedBytes');
      return usedBytes;
    }),
    markWriteStarted: vi.fn(async (_o: string, ids: readonly string[]) => {
      trace.push(`markWrite:${ids.join(',')}`);
      for (const id of ids) {
        marks.add(id);
        detachedMarks.add(id);
      }
    }),
    hasWriteMarks: vi.fn(async (_o: string, objectId: string) =>
      [...marks].some((id) => versions.get(id)?.objectId === objectId),
    ),
    clearWriteMarks: vi.fn(async (_o: string, objectId: string) => {
      trace.push(`clearMarks:${objectId}`);
      marks = new Set(
        [...marks].filter((id) => versions.get(id)?.objectId !== objectId),
      );
    }),
    committedS3VersionIds: vi.fn(async (_o: string, objectId: string) =>
      [...versions.values()]
        .filter((v) => v.objectId === objectId && v.status === 'committed')
        .map((v) => v.s3VersionId!),
    ),
    staleWriteMarks: vi.fn(async () =>
      [...new Set([...marks].map((id) => versions.get(id)!.objectId))].map(
        (objectId) => ({ organizationId: ORG, spaceId: SPACE, objectId }),
      ),
    ),
  };
  const store = {
    presignPut: vi.fn(async (key: string, input: { sizeBytes: number }) => ({
      url: `https://s3/${key}`,
      headers: {
        'content-length': String(input.sizeBytes),
        'x-amz-tagging': 'stage=upload',
      },
    })),
    head: vi.fn(async (key: string) => {
      trace.push(`head:${key.split('/').pop()}`);
      const id = key.split('/').pop()!;
      if (heads.has(id))
        return heads.get(id) === null
          ? null
          : { ...heads.get(id)!, versionId: 'x' };
      const v = versions.get(id);
      return v
        ? { sizeBytes: v.sizeBytes, sha256Hex: v.sha256, versionId: 'x' }
        : null;
    }),
    copy: vi.fn(async (_from: string, to: string) => {
      trace.push(`copy:${to.split('/').pop()}`);
      const versionId = `s3-${++s3}`;
      versionsOf(to).push({ versionId, isDeleteMarker: false });
      return { versionId };
    }),
    deleteCurrent: vi.fn(async (key: string) => {
      trace.push(`deleteCurrent:${key.split('/').pop()}`);
      const versionId = `dm-${++s3}`;
      versionsOf(key).push({ versionId, isDeleteMarker: true });
      return { deleteMarkerVersionId: versionId };
    }),
    deleteVersion: vi.fn(async (key: string, versionId: string) => {
      trace.push(`deleteVersion:${key.split('/').pop()}:${versionId}`);
      bucket.set(
        key,
        versionsOf(key).filter((v) => v.versionId !== versionId),
      );
    }),
    listVersions: vi.fn(async (key: string) => [...versionsOf(key)]),
    presignGet: vi.fn(),
  };
  let detachedMarks = new Set<string>();
  const uow = {
    run: vi.fn(async <T>(work: () => Promise<T>) => {
      trace.push('run');
      const saved = {
        objects: new Map([...objects].map(([k, o]) => [k, cloneObject(o)])),
        versions: new Map([...versions].map(([k, v]) => [k, cloneVersion(v)])),
        marks: new Set(marks),
      };
      detachedMarks = new Set();
      try {
        const result = await work();
        if (mode === 'commitThenReject') {
          mode = 'normal';
          trace.push('commit-lost');
          throw new Error('connection lost during COMMIT');
        }
        trace.push('commit');
        return result;
      } catch (error) {
        if (!trace.includes('commit-lost') || trace.at(-1) !== 'commit-lost') {
          objects = saved.objects;
          versions = saved.versions;
          marks = new Set([...saved.marks, ...detachedMarks]);
          trace.push('rollback');
        }
        throw error;
      }
    }),
    detached: vi.fn(async <T>(work: () => Promise<T>) => work()),
  };
  const objectRepoDep = objectRepo as unknown as BackupObjectRepository;
  const versionRepoDep =
    versionRepo as unknown as BackupObjectVersionRepository;
  const storeDep = store as unknown as ObjectStore;
  const uowDep = uow as unknown as UnitOfWork;
  const healer = new BackupObjectHealer(
    objectRepoDep,
    versionRepoDep,
    storeDep,
    uowDep,
  );
  const accessDep = access as unknown as StorageAccess;
  return {
    trace,
    state,
    get objects() {
      return objects;
    },
    get versions() {
      return versions;
    },
    get marks() {
      return marks;
    },
    bucket,
    foreignObjects,
    heads,
    setUsed: (n: number) => {
      usedBytes = n;
    },
    loseNextCommit: () => {
      mode = 'commitThenReject';
    },
    mocks: { access, objectRepo, versionRepo, store, uow },
    request: new RequestUploadsUseCase(
      accessDep,
      objectRepoDep,
      versionRepoDep,
      storeDep,
      uowDep,
    ),
    confirm: new ConfirmUploadsUseCase(
      accessDep,
      objectRepoDep,
      versionRepoDep,
      storeDep,
      healer,
      uowDep,
    ),
    remove: new DeleteObjectsUseCase(
      accessDep,
      objectRepoDep,
      versionRepoDep,
      storeDep,
      healer,
      uowDep,
    ),
    reconcile: new ReconcileStorageUseCase(versionRepoDep, healer),
  };
}

function cloneObject(o: BackupObject): BackupObject {
  return BackupObject.restore(snapshot(o));
}

function cloneVersion(v: BackupObjectVersion): BackupObjectVersion {
  return BackupObjectVersion.restore({
    id: v.id,
    organizationId: v.organizationId,
    spaceId: v.spaceId,
    objectId: v.objectId,
    keyVersion: v.keyVersion,
    sizeBytes: v.sizeBytes,
    sha256: v.sha256,
    status: v.status,
    replacesVersionId: v.replacesVersionId,
    s3VersionId: v.s3VersionId,
    uploader: v.uploader,
    uploadExpiresAt: v.uploadExpiresAt,
    committedAt: v.committedAt,
    supersededAt: v.supersededAt,
  });
}

function snapshot(o: BackupObject) {
  return {
    id: o.id,
    organizationId: o.organizationId,
    spaceId: o.spaceId,
    currentVersionId: o.currentVersionId,
    deletedAt: o.deletedAt,
  };
}

const item = (objectId: string, over: Record<string, unknown> = {}) => ({
  objectId,
  keyVersion: 2,
  sizeBytes: 1000,
  sha256: SHA,
  replacesVersionId: null as string | null,
  ...over,
});

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe('RequestUploadsUseCase', () => {
  it('locks the space for memory.write, reserves pending versions and returns presigned PUTs under uploads/', async () => {
    const out = await t.request.execute(
      HUB,
      SPACE,
      [item(OBJ_B), item(OBJ_A)],
      NOW,
    );
    expect(t.mocks.access.lock).toHaveBeenCalledWith(
      SPACE,
      HUB,
      'memory.write',
      'update',
    );
    expect(out.map((o) => o.objectId)).toEqual([OBJ_B, OBJ_A]);
    for (const o of out) {
      const v = t.versions.get(o.uploadId)!;
      expect(v.status).toBe('pending');
      expect(v.uploader).toEqual(HUB);
      expect(o.url).toBe(
        `https://s3/orgs/${ORG}/spaces/${SPACE}/uploads/${o.uploadId}`,
      );
      expect(o.headers).toMatchObject({ 'x-amz-tagging': 'stage=upload' });
      expect(o.expiresAt).toEqual(new Date(NOW.getTime() + 15 * 60_000));
    }
    // Objects locked in id order, usage read after the previous intents ended, presign after the commit.
    expect(t.trace.filter((s) => s.startsWith('lockOrCreate'))).toEqual([
      `lockOrCreate:${OBJ_A}`,
      `lockOrCreate:${OBJ_B}`,
    ]);
    expect(t.trace.indexOf('usedBytes')).toBeGreaterThan(
      t.trace.indexOf(`expirePending:${OBJ_B}`),
    );
    expect(t.mocks.store.presignPut).toHaveBeenCalledTimes(2);
    expect(t.trace.indexOf('commit')).toBeGreaterThan(
      t.trace.indexOf('usedBytes'),
    );
  });

  it('pending rotation and stale key version are 409; nothing is reserved', async () => {
    t.state.keyRotationRequired = true;
    await expect(
      t.request.execute(HUB, SPACE, [item(OBJ_A)], NOW),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'space-key-rotation-required',
    });
    t.state.keyRotationRequired = false;
    await expect(
      t.request.execute(HUB, SPACE, [item(OBJ_A, { keyVersion: 1 })], NOW),
    ).rejects.toMatchObject({ code: 'space-key-version-stale' });
    expect(t.versions.size).toBe(0);
  });

  it('a full space is 422 with the missing bytes (all or nothing)', async () => {
    t.setUsed(10 * GiB - 1500);
    await expect(
      t.request.execute(HUB, SPACE, [item(OBJ_A), item(OBJ_B)], NOW),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'space-storage-full',
      details: { missingBytes: 500 },
    });
    expect(t.versions.size).toBe(0);
  });

  it('above 5 GiB: 422 object-too-large before touching the space; duplicate objects: 422', async () => {
    await expect(
      t.request.execute(
        HUB,
        SPACE,
        [item(OBJ_A, { sizeBytes: MAX_OBJECT_BYTES + 1 })],
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'object-too-large' });
    await expect(
      t.request.execute(HUB, SPACE, [item(OBJ_A), item(OBJ_A)], NOW),
    ).rejects.toMatchObject({ code: 'duplicate-object' });
    expect(t.mocks.access.lock).not.toHaveBeenCalled();
  });

  it('replacing something other than the live version is 409; an id of another space is 409', async () => {
    await expect(
      t.request.execute(
        HUB,
        SPACE,
        [item(OBJ_A, { replacesVersionId: OBJ_B })],
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'object-version-conflict' });
    t.foreignObjects.add(OBJ_B);
    await expect(
      t.request.execute(HUB, SPACE, [item(OBJ_B)], NOW),
    ).rejects.toMatchObject({
      code: 'object-version-conflict',
    });
  });
});

describe('ConfirmUploadsUseCase', () => {
  const intent = async (objectId: string, over: Record<string, unknown> = {}) =>
    (await t.request.execute(HUB, SPACE, [item(objectId, over)], NOW))[0]!
      .uploadId;

  it('heads, copies to objects/<objectId>, commits and supersedes the previous version', async () => {
    const first = await intent(OBJ_A);
    const [c1] = await t.confirm.execute(HUB, SPACE, [first], NOW);
    expect(c1).toMatchObject({
      uploadId: first,
      versionId: first,
      objectId: OBJ_A,
      sizeBytes: 1000,
      sha256: SHA,
    });
    expect(t.versions.get(first)!.status).toBe('committed');
    expect(t.versions.get(first)!.s3VersionId).toBe('s3-1');
    expect(t.objects.get(OBJ_A)!.liveVersionId).toBe(first);

    const second = await intent(OBJ_A, { replacesVersionId: first });
    t.trace.length = 0;
    await t.confirm.execute(HUB, SPACE, [second], NOW);
    expect(t.trace).toEqual([
      'run',
      'lock:memory.write:share',
      `lockObject:${OBJ_A}`,
      `head:${second}`,
      `markWrite:${second}`,
      `copy:${OBJ_A}`,
      `saveVersion:${second}`,
      `superseded:${first}`,
      `saveObject:${OBJ_A}`,
      `clearMarks:${OBJ_A}`,
      'commit',
    ]);
    expect(t.marks.size).toBe(0);
  });

  it('only the uploader confirms: another hub or a person gets 404 upload-not-found', async () => {
    const id = await intent(OBJ_A);
    for (const other of [{ hubId: 'other' }, { userId: 'u' }]) {
      await expect(
        t.confirm.execute(other, SPACE, [id], NOW),
      ).rejects.toMatchObject({ code: 'upload-not-found' });
    }
  });

  it('confirming again is idempotent: one version, no second copy', async () => {
    const id = await intent(OBJ_A);
    const a = await t.confirm.execute(HUB, SPACE, [id], NOW);
    const b = await t.confirm.execute(HUB, SPACE, [id], NOW);
    expect(b).toEqual(a);
    expect(t.mocks.store.copy).toHaveBeenCalledTimes(1);
  });

  it('a provisional object different from the declaration is 422 upload-mismatch; nothing changes', async () => {
    const id = await intent(OBJ_A);
    for (const head of [
      null,
      { sizeBytes: 999, sha256Hex: SHA },
      { sizeBytes: 0, sha256Hex: SHA },
      { sizeBytes: 1000, sha256Hex: null },
    ]) {
      t.heads.set(id, head);
      await expect(
        t.confirm.execute(HUB, SPACE, [id], NOW),
      ).rejects.toMatchObject({
        constructor: DomainValidationError,
        code: 'upload-mismatch',
      });
    }
    expect(t.mocks.store.copy).not.toHaveBeenCalled();
    expect(t.versions.get(id)!.status).toBe('pending');
    expect(t.objects.get(OBJ_A)!.liveVersionId).toBeNull();
  });

  it('a rotation that became pending after the intent refuses the confirmation (409); nothing is copied', async () => {
    const id = await intent(OBJ_A);
    t.state.keyRotationRequired = true;
    await expect(
      t.confirm.execute(HUB, SPACE, [id], NOW),
    ).rejects.toMatchObject({
      code: 'space-key-rotation-required',
    });
    t.state.keyRotationRequired = false;
    t.state.currentKeyVersion = 3;
    await expect(
      t.confirm.execute(HUB, SPACE, [id], NOW),
    ).rejects.toMatchObject({
      code: 'space-key-version-stale',
    });
    expect(t.mocks.store.copy).not.toHaveBeenCalled();
  });

  it('two writers replacing the same version: the second confirmation is 409', async () => {
    const one = await intent(OBJ_A);
    const two = (
      await t.request.execute({ hubId: 'other' }, SPACE, [item(OBJ_A)], NOW)
    )[0]!.uploadId;
    await t.confirm.execute(HUB, SPACE, [one], NOW);
    await expect(
      t.confirm.execute({ hubId: 'other' }, SPACE, [two], NOW),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'object-version-conflict',
      details: { objectId: OBJ_A, currentVersionId: one },
    });
  });

  it('unknown, other space or past the window: 404 upload-not-found', async () => {
    await expect(
      t.confirm.execute(
        HUB,
        SPACE,
        ['01900000-0000-7000-8000-0000000000ff'],
        NOW,
      ),
    ).rejects.toMatchObject({
      constructor: NotFoundError,
      code: 'upload-not-found',
    });
    const id = await intent(OBJ_A);
    await expect(
      t.confirm.execute(
        HUB,
        SPACE,
        [id],
        new Date(NOW.getTime() + 25 * 3600_000),
      ),
    ).rejects.toMatchObject({ code: 'upload-not-found' });
  });

  it('a failure after a copy (rollback) repairs the bucket: the copies no committed row references are removed', async () => {
    const a = await intent(OBJ_A);
    const b = await intent(OBJ_B);
    t.mocks.store.copy.mockImplementationOnce(
      async (_f: string, to: string) => {
        t.bucket.set(to, [{ versionId: 'ok-1', isDeleteMarker: false }]);
        return { versionId: 'ok-1' };
      },
    );
    t.mocks.store.copy.mockImplementationOnce(async () => {
      throw new Error('s3 down');
    });
    await expect(t.confirm.execute(HUB, SPACE, [a, b], NOW)).rejects.toThrow(
      's3 down',
    );
    expect(t.mocks.store.deleteVersion).toHaveBeenCalledWith(
      `orgs/${ORG}/spaces/${SPACE}/objects/${OBJ_A}`,
      'ok-1',
    );
    expect(t.versions.get(a)!.status).toBe('pending');
    expect(t.marks.size).toBe(0);
  });

  it('COMMIT applied but run() rejects: the repair deletes nothing the index references', async () => {
    const first = await intent(OBJ_A);
    await t.confirm.execute(HUB, SPACE, [first], NOW);
    const second = await intent(OBJ_A, { replacesVersionId: first });
    t.loseNextCommit();
    await expect(t.confirm.execute(HUB, SPACE, [second], NOW)).rejects.toThrow(
      'connection lost during COMMIT',
    );
    expect(t.versions.get(second)!.status).toBe('committed');
    expect(t.mocks.store.deleteVersion).not.toHaveBeenCalled();
    expect(
      t.bucket.get(`orgs/${ORG}/spaces/${SPACE}/objects/${OBJ_A}`),
    ).toHaveLength(2);
    // Retried by the hub: idempotent.
    await expect(
      t.confirm.execute(HUB, SPACE, [second], NOW),
    ).resolves.toMatchObject([{ versionId: second }]);
  });

  it('self-heal on next touch: a stray S3 version left by a crash is removed before the next copy', async () => {
    const first = await intent(OBJ_A);
    await t.confirm.execute(HUB, SPACE, [first], NOW);
    const key = `orgs/${ORG}/spaces/${SPACE}/objects/${OBJ_A}`;
    // A crashed confirmation: marked, copied, never committed.
    const lost = await intent(OBJ_A, { replacesVersionId: first });
    t.marks.add(lost);
    t.bucket.get(key)!.push({ versionId: 'stray', isDeleteMarker: false });

    const next = await intent(OBJ_A, { replacesVersionId: first });
    await t.confirm.execute(HUB, SPACE, [next], NOW);
    expect(t.mocks.store.deleteVersion).toHaveBeenCalledWith(key, 'stray');
    expect(t.bucket.get(key)!.map((v) => v.versionId)).toEqual([
      t.versions.get(first)!.s3VersionId,
      t.versions.get(next)!.s3VersionId,
    ]);
    expect(t.marks.size).toBe(0);
  });

  it('the reconcile sweep repairs objects nobody touches again', async () => {
    const first = await intent(OBJ_A);
    await t.confirm.execute(HUB, SPACE, [first], NOW);
    const key = `orgs/${ORG}/spaces/${SPACE}/objects/${OBJ_A}`;
    const lost = await intent(OBJ_A, { replacesVersionId: first });
    t.marks.add(lost);
    t.bucket.get(key)!.push({ versionId: 'stray', isDeleteMarker: false });
    t.bucket.get(key)!.push({ versionId: 'stray-dm', isDeleteMarker: true });

    await expect(t.reconcile.execute({}, NOW)).resolves.toEqual({
      objects: 1,
      removedVersions: 2,
    });
    expect(t.bucket.get(key)!.map((v) => v.versionId)).toEqual([
      t.versions.get(first)!.s3VersionId,
    ]);
    expect(t.marks.size).toBe(0);
  });
});

describe('DeleteObjectsUseCase', () => {
  const committed = async (objectId: string) => {
    const id = (await t.request.execute(HUB, SPACE, [item(objectId)], NOW))[0]!
      .uploadId;
    await t.confirm.execute(HUB, SPACE, [id], NOW);
    return id;
  };

  it('needs memory.delete; tombstones the object, supersedes the version and leaves a delete marker', async () => {
    const v = await committed(OBJ_A);
    await t.remove.execute(
      { userId: 'u' },
      SPACE,
      [{ objectId: OBJ_A, replacesVersionId: v }],
      NOW,
    );
    expect(t.mocks.access.lock).toHaveBeenLastCalledWith(
      SPACE,
      { userId: 'u' },
      'memory.delete',
      'share',
    );
    expect(t.objects.get(OBJ_A)!.deletedAt).toEqual(NOW);
    expect(t.trace).toContain(`superseded:${v}`);
    expect(t.trace).toContain(`deleteCurrent:${OBJ_A}`);
    // Again: no-op, no second marker.
    t.mocks.store.deleteCurrent.mockClear();
    await t.remove.execute(
      { userId: 'u' },
      SPACE,
      [{ objectId: OBJ_A, replacesVersionId: v }],
      NOW,
    );
    expect(t.mocks.store.deleteCurrent).not.toHaveBeenCalled();
  });

  it('another version or an unknown object: 409; a rolled back batch removes the markers it left', async () => {
    const v = await committed(OBJ_A);
    await expect(
      t.remove.execute(
        { userId: 'u' },
        SPACE,
        [{ objectId: OBJ_B, replacesVersionId: v }],
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'object-version-conflict' });
    const w = await committed(OBJ_B);
    t.mocks.objectRepo.save.mockRejectedValueOnce(new Error('db down'));
    await expect(
      t.remove.execute(
        { userId: 'u' },
        SPACE,
        [
          { objectId: OBJ_A, replacesVersionId: v },
          { objectId: OBJ_B, replacesVersionId: w },
        ],
        NOW,
      ),
    ).rejects.toThrow('db down');
    expect(t.mocks.store.deleteVersion).toHaveBeenCalledTimes(2);
    for (const id of [OBJ_A, OBJ_B]) {
      expect(
        t.bucket
          .get(`orgs/${ORG}/spaces/${SPACE}/objects/${id}`)!
          .some((x) => x.isDeleteMarker),
      ).toBe(false);
      expect(t.objects.get(id)!.deletedAt).toBeNull();
    }
    expect(t.marks.size).toBe(0);
  });

  it('a delete whose COMMIT was applied but lost keeps its delete marker', async () => {
    const v = await committed(OBJ_A);
    t.loseNextCommit();
    await expect(
      t.remove.execute(
        { userId: 'u' },
        SPACE,
        [{ objectId: OBJ_A, replacesVersionId: v }],
        NOW,
      ),
    ).rejects.toThrow('connection lost during COMMIT');
    expect(t.mocks.store.deleteVersion).not.toHaveBeenCalled();
    expect(t.objects.get(OBJ_A)!.deletedAt).toEqual(NOW);
    expect(
      t.bucket
        .get(`orgs/${ORG}/spaces/${SPACE}/objects/${OBJ_A}`)!
        .map((x) => x.isDeleteMarker),
    ).toEqual([false, true]);
  });
});
