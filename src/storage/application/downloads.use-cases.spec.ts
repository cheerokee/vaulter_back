import {
  DomainValidationError,
  NotFoundError,
} from '../../shared/domain/errors.js';
import { encodeCursor } from '../../shared/domain/pagination.js';
import { GetDownloadUrlUseCase } from './get-download-url.use-case.js';
import { ListObjectsUseCase } from './list-objects.use-case.js';
import type { BackupIndexReader } from './ports/backup-index-reader.js';
import type { ObjectStore } from './ports/object-store.js';
import type { StorageAccess } from './storage-access.js';

const NOW = new Date('2026-11-09T12:00:00Z');
const AS_OF = new Date('2026-11-09T11:59:59Z');
const ORG = '01900000-0000-7000-8000-000000000001';
const SPACE = '01900000-0000-7000-8000-000000000002';
const OBJ = '01900000-0000-7000-8000-00000000000a';
const VER = '01900000-0000-7000-8000-0000000000c1';
const HUB = { hubId: '01900000-0000-7000-8000-0000000000b1' };

function setup() {
  const access = {
    require: vi.fn(async () => ({
      organizationId: ORG,
      spaceId: SPACE,
      currentKeyVersion: 1,
      keyRotationRequired: false,
      storageQuotaBytes: 1,
    })),
    lock: vi.fn(),
  };
  const version = (id: string) => ({
    versionId: id,
    keyVersion: 1,
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    uploadedAt: NOW,
  });
  const reader = {
    listObjects: vi.fn(async () => ({
      asOf: AS_OF,
      rows: ['o1', 'o2', 'o3'].map((objectId) => ({
        objectId,
        deleted: false,
        deletedAt: null,
        currentVersion: version(`v-${objectId}`),
      })),
    })),
    listVersions: vi.fn(async () => ({
      asOf: AS_OF,
      rows: [
        { ...version('v1'), objectId: OBJ, supersededAt: NOW, current: false },
      ],
    })),
    downloadableS3VersionId: vi.fn(async (): Promise<string | null> => 's3v'),
  };
  const store = {
    presignGet: vi.fn(async () => 'https://s3.example/signed'),
  };
  const list = new ListObjectsUseCase(
    access as unknown as StorageAccess,
    reader as unknown as BackupIndexReader,
  );
  const download = new GetDownloadUrlUseCase(
    access as unknown as StorageAccess,
    reader as unknown as BackupIndexReader,
    store as unknown as ObjectStore,
  );
  return { access, reader, store, list, download };
}

describe('ListObjectsUseCase', () => {
  it('checks memory.read (no lock) and pages the objects by id with the asOf of the query', async () => {
    const t = setup();
    const res = await t.list.execute(HUB, SPACE, {
      include: 'current',
      limit: 2,
      cursor: encodeCursor(OBJ),
    });
    expect(t.access.require).toHaveBeenCalledWith(SPACE, HUB, 'memory.read');
    expect(t.access.lock).not.toHaveBeenCalled();
    expect(t.reader.listObjects).toHaveBeenCalledWith(
      ORG,
      SPACE,
      { include: 'current' },
      { after: OBJ, limit: 2 },
    );
    expect(res.include).toBe('current');
    expect(
      res.page.items.map((i) => ('objectId' in i ? i.objectId : '')),
    ).toEqual(['o1', 'o2']);
    expect(res.page.nextCursor).toBe(encodeCursor('o2'));
    expect(res.asOf).toEqual(AS_OF);
  });

  it('passes since to current and trash; versions need objectId and refuse since', async () => {
    const t = setup();
    await t.list.execute(HUB, SPACE, {
      include: 'trash',
      since: NOW,
      limit: 5,
    });
    expect(t.reader.listObjects).toHaveBeenCalledWith(
      ORG,
      SPACE,
      { include: 'trash', since: NOW },
      { after: undefined, limit: 5 },
    );
    const versions = await t.list.execute(HUB, SPACE, {
      include: 'versions',
      objectId: OBJ,
      limit: 5,
    });
    expect(versions.include).toBe('versions');
    expect(t.reader.listVersions).toHaveBeenCalledWith(ORG, SPACE, OBJ, {
      after: undefined,
      limit: 5,
    });

    for (const q of [
      { include: 'versions' as const, limit: 5 },
      { include: 'versions' as const, objectId: OBJ, since: NOW, limit: 5 },
      { include: 'current' as const, objectId: OBJ, limit: 5 },
      { include: 'current' as const, cursor: '!!', limit: 5 },
    ]) {
      await expect(t.list.execute(HUB, SPACE, q)).rejects.toBeInstanceOf(
        DomainValidationError,
      );
    }
  });

  it('access errors pass through before any read of the index', async () => {
    const t = setup();
    t.access.require.mockRejectedValueOnce(
      new NotFoundError('space-not-found', 'The space was not found.'),
    );
    await expect(
      t.list.execute(HUB, SPACE, { include: 'current', limit: 5 }),
    ).rejects.toMatchObject({ code: 'space-not-found' });
    expect(t.reader.listObjects).not.toHaveBeenCalled();
  });
});

describe('GetDownloadUrlUseCase', () => {
  it('signs a GET of the index S3 version of objects/<objectId> for 15 min', async () => {
    const t = setup();
    const res = await t.download.execute(HUB, SPACE, OBJ, VER, NOW);
    expect(t.access.require).toHaveBeenCalledWith(SPACE, HUB, 'memory.read');
    expect(t.reader.downloadableS3VersionId).toHaveBeenCalledWith(
      ORG,
      SPACE,
      OBJ,
      VER,
    );
    expect(t.store.presignGet).toHaveBeenCalledWith(
      `orgs/${ORG}/spaces/${SPACE}/objects/${OBJ}`,
      's3v',
      900,
    );
    expect(res).toEqual({
      url: 'https://s3.example/signed',
      expiresAt: new Date(NOW.getTime() + 15 * 60_000),
    });
  });

  it('a version the index does not serve (pending, out of the trash, unknown) is 404 version-not-found, unsigned', async () => {
    const t = setup();
    t.reader.downloadableS3VersionId.mockResolvedValueOnce(null);
    await expect(
      t.download.execute(HUB, SPACE, OBJ, VER, NOW),
    ).rejects.toMatchObject({ code: 'version-not-found' });
    expect(t.store.presignGet).not.toHaveBeenCalled();
  });
});
