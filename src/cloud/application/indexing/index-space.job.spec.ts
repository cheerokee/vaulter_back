import { hubManifestObjectId } from '../../../shared/domain/space-manifest-ids.js';
import type { UnitOfWork } from '../../../shared/infra/db/unit-of-work.js';
import type { SpaceCloud } from '../../../spaces/application/space-cloud.js';
import type { CloudFile } from '../../domain/cloud-file.js';
import type {
  CloudChunkRepository,
  CloudFileRepository,
} from '../../domain/indexing.repositories.js';
import type { BackupPlaintextReader } from './backup-plaintext-reader.js';
import type { CloudIndexingQueue } from './cloud-indexing-queue.js';
import { IndexSpaceJob } from './index-space.job.js';
import type { SpaceKeyOpener } from './space-keys.js';

const ORG = '0195f3a2-7c4e-7b1d-9a3f-00000000000a';
const SPACE = '0195f3a2-7c4e-7b1d-9a3f-2c8e5d4b6a10';
const FILE = '0195f3a2-7c4e-7b1d-9a3f-000000000001';
const PART = '0195f3a2-7c4e-7b1d-9a3f-0000000000a1';
const HUB_MANIFEST = hubManifestObjectId(SPACE);

const live = (objectId: string, versionId: string) => ({
  objectId,
  versionId,
  keyVersion: 1,
  sizeBytes: 100,
  sha256: 'x',
  uploadedAt: new Date(),
  s3VersionId: 's3',
});
const manifest = (doc: unknown, version = 1) =>
  new Uint8Array([version, ...new TextEncoder().encode(JSON.stringify(doc))]);
const GOOD = manifest({
  spaceId: SPACE,
  writer: 'hub',
  files: [
    {
      fileId: FILE,
      name: 'a.md',
      mediaType: 'text/markdown',
      source: { kind: 'file' },
      parts: [PART],
    },
  ],
});

function setup(plaintext: Uint8Array = GOOD) {
  let active = true;
  const versions = new Map([
    [HUB_MANIFEST, live(HUB_MANIFEST, 'm1')],
    [PART, live(PART, 'v1')],
  ]);
  const spaceCloud = {
    modeOf: vi.fn(async () => 'active_cloud'),
    lockActiveForWrite: vi.fn(async () => active),
  };
  const keys = { get: vi.fn(), wipe: vi.fn() };
  const reader = {
    liveVersions: vi.fn(
      async (_o: string, _s: string, ids: readonly string[]) =>
        new Map(
          ids.flatMap((id) =>
            versions.has(id) ? [[id, versions.get(id)!]] : [],
          ),
        ),
    ),
    open: vi.fn(async () => plaintext),
  };
  const files = {
    lockForSpace: vi.fn(async (): Promise<CloudFile[]> => []),
    deleteByIds: vi.fn(async () => undefined),
    upsert: vi.fn(async () => undefined),
  };
  const chunks = { deleteForFile: vi.fn(async () => undefined) };
  const queue = { enqueueFile: vi.fn(async () => undefined) };
  const uow = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const job = new IndexSpaceJob(
    spaceCloud as unknown as SpaceCloud,
    { forSpace: async () => keys } as unknown as SpaceKeyOpener,
    reader as unknown as BackupPlaintextReader,
    files as unknown as CloudFileRepository,
    chunks as unknown as CloudChunkRepository,
    queue as unknown as CloudIndexingQueue,
    uow as unknown as UnitOfWork,
  );
  return {
    job,
    keys,
    reader,
    files,
    queue,
    uow,
    versions,
    plaintext,
    deactivate: () => {
      active = false;
    },
  };
}

describe('IndexSpaceJob', () => {
  const payload = { organizationId: ORG, spaceId: SPACE };

  it('lists the manifest files as pending and enqueues one job each, in one transaction; key and plaintext wiped', async () => {
    const k = setup();
    await k.job.run(payload);
    expect(k.files.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        spaceId: SPACE,
        fileId: FILE,
        status: 'pending',
        parts: [{ objectId: PART, versionId: 'v1' }],
      }),
    );
    expect(k.queue.enqueueFile).toHaveBeenCalledTimes(1);
    expect(k.keys.wipe).toHaveBeenCalled();
    expect(k.plaintext.every((b) => b === 0)).toBe(true);
  });

  it('a manifest that breaks the contract: the index is kept as it was (no transaction)', async () => {
    const k = setup(manifest({ spaceId: SPACE, writer: 'hub', files: [] }, 2));
    await k.job.run(payload);
    expect(k.uow.run).not.toHaveBeenCalled();
    expect(k.keys.wipe).toHaveBeenCalled();
  });

  it('switched off before writing: nothing; a version changed meanwhile: nothing (a newer pass follows)', async () => {
    const k = setup();
    k.deactivate();
    await k.job.run(payload);
    expect(k.files.lockForSpace).not.toHaveBeenCalled();

    const k2 = setup();
    k2.files.lockForSpace.mockImplementationOnce(async () => {
      k2.versions.set(PART, live(PART, 'v2'));
      return [];
    });
    await k2.job.run(payload);
    expect(k2.files.upsert).not.toHaveBeenCalled();
    expect(k2.queue.enqueueFile).not.toHaveBeenCalled();
  });

  it('no manifest yet: every known file is removed', async () => {
    const k = setup();
    k.versions.delete(HUB_MANIFEST);
    k.files.lockForSpace.mockResolvedValueOnce([
      { id: 'row-1', fileId: FILE } as CloudFile,
    ]);
    await k.job.run(payload);
    expect(k.files.deleteByIds).toHaveBeenCalledWith(ORG, ['row-1']);
  });
});
