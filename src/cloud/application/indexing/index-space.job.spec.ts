import { hubManifestObjectId } from '../../../shared/domain/space-manifest-ids.js';
import type { UnitOfWork } from '../../../shared/infra/db/unit-of-work.js';
import type { SpaceCloud } from '../../../spaces/application/space-cloud.js';
import type { CloudFile } from '../../domain/cloud-file.js';
import type {
  CloudChunkRepository,
  CloudFileRepository,
} from '../../domain/indexing.repositories.js';
import {
  INDEX_SPACE_BATCH_FILES,
  INDEX_SPACE_BATCH_TIMEOUT_MS,
  INDEX_SPACE_LOCK_TIMEOUT_MS,
} from '../../domain/indexing-limits.js';
import type { BackupPlaintextReader } from './backup-plaintext-reader.js';
import type { CloudIndexingQueue } from './cloud-indexing-queue.js';
import { IndexSpaceJob } from './index-space.job.js';
import type { SpaceKeyOpener } from './space-keys.js';

const ORG = '0195f3a2-7c4e-7b1d-9a3f-00000000000a';
const SPACE = '0195f3a2-7c4e-7b1d-9a3f-2c8e5d4b6a10';
const HUB_MANIFEST = hubManifestObjectId(SPACE);
const hex = (n: number) => n.toString(16).padStart(12, '0');
const fileId = (n: number) => `0195f3a2-7c4e-7b1d-9a3f-${hex(n)}`;
const partId = (n: number) => `0195f3a2-7c4e-7b1d-8a3f-${hex(n)}`;

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
const manifestOf = (n: number) =>
  manifest({
    spaceId: SPACE,
    writer: 'hub',
    files: Array.from({ length: n }, (_, i) => ({
      fileId: fileId(i + 1),
      name: `f${i}.md`,
      mediaType: 'text/markdown',
      source: { kind: 'file' },
      parts: [partId(i + 1)],
    })),
  });

function setup(files = 1, plaintext: Uint8Array = manifestOf(files)) {
  let active = true;
  const trace: string[] = [];
  const versions = new Map([[HUB_MANIFEST, live(HUB_MANIFEST, 'm1')]]);
  for (let i = 1; i <= files; i += 1) {
    versions.set(partId(i), live(partId(i), 'v1'));
  }
  const spaceCloud = {
    modeOf: vi.fn(async () => 'active_cloud'),
    lockActiveForWrite: vi.fn(async () => {
      trace.push('lockActiveForWrite');
      return active;
    }),
  };
  const keys = { get: vi.fn(), wipe: vi.fn() };
  const reader = {
    liveVersions: vi.fn(
      async (_o: string, _s: string, ids: readonly string[]) =>
        new Map(
          ids.flatMap((id) =>
            versions.has(id) ? [[id, versions.get(id)!] as const] : [],
          ),
        ),
    ),
    open: vi.fn(async () => plaintext),
  };
  const repo = {
    listForSpace: vi.fn(async (): Promise<CloudFile[]> => []),
    lockByFileIds: vi.fn(async (): Promise<CloudFile[]> => {
      trace.push('lockByFileIds');
      return [];
    }),
    deleteByIds: vi.fn(async () => undefined),
    upsertMany: vi.fn(async (fs: readonly CloudFile[]) => {
      trace.push(`upsertMany:${fs.length}`);
      return new Map(fs.map((f) => [f.fileId, f.id]));
    }),
  };
  const chunks = { deleteForFiles: vi.fn(async () => undefined) };
  const queue = {
    enqueueFiles: vi.fn(async (_o: string, _s: string, ids: string[]) => {
      trace.push(`enqueueFiles:${ids.length}`);
    }),
  };
  const uow = {
    run: vi.fn(async (fn: () => Promise<unknown>) => {
      trace.push('run');
      return fn();
    }),
    setLockTimeout: vi.fn(async () => undefined),
    limitRemainingTime: vi.fn(async () => undefined),
  };
  const job = new IndexSpaceJob(
    spaceCloud as unknown as SpaceCloud,
    { forSpace: async () => keys } as unknown as SpaceKeyOpener,
    reader as unknown as BackupPlaintextReader,
    repo as unknown as CloudFileRepository,
    chunks as unknown as CloudChunkRepository,
    queue as unknown as CloudIndexingQueue,
    uow as unknown as UnitOfWork,
  );
  return {
    job,
    trace,
    keys,
    reader,
    repo,
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

  it('lists the manifest files as pending and enqueues them in one statement; key and plaintext wiped', async () => {
    const k = setup();
    await k.job.run(payload);
    expect(k.repo.upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        organizationId: ORG,
        spaceId: SPACE,
        fileId: fileId(1),
        status: 'pending',
        parts: [{ objectId: partId(1), versionId: 'v1' }],
      }),
    ]);
    expect(k.queue.enqueueFiles).toHaveBeenCalledTimes(1);
    expect(k.keys.wipe).toHaveBeenCalled();
    expect(k.plaintext.every((b) => b === 0)).toBe(true);
  });

  it('a big space is applied in short batches of a fixed number of statements, each with lock and time limits', async () => {
    const n = INDEX_SPACE_BATCH_FILES * 2 + 1;
    const k = setup(n);
    await k.job.run(payload);
    expect(k.uow.run).toHaveBeenCalledTimes(3);
    expect(k.repo.upsertMany.mock.calls.map((c) => c[0].length)).toEqual([
      INDEX_SPACE_BATCH_FILES,
      INDEX_SPACE_BATCH_FILES,
      1,
    ]);
    expect(k.queue.enqueueFiles).toHaveBeenCalledTimes(3);
    // Per batch: the space lock first, then only the batch's rows; never one row at a time.
    expect(k.trace.filter((t) => t === 'lockByFileIds')).toHaveLength(3);
    expect(k.uow.setLockTimeout).toHaveBeenCalledWith(
      INDEX_SPACE_LOCK_TIMEOUT_MS,
    );
    expect(k.uow.limitRemainingTime).toHaveBeenCalledWith(
      INDEX_SPACE_BATCH_TIMEOUT_MS,
    );
    // Reads per batch are constant (2 re-reads), not proportional to the files.
    const inBatches = k.reader.liveVersions.mock.calls.length - 2;
    expect(inBatches).toBe(3 * 2);
  });

  it('a manifest that breaks the contract: the index is kept as it was (no transaction)', async () => {
    const k = setup(
      1,
      manifest({ spaceId: SPACE, writer: 'hub', files: [] }, 2),
    );
    await k.job.run(payload);
    expect(k.uow.run).not.toHaveBeenCalled();
    expect(k.keys.wipe).toHaveBeenCalled();
  });

  it('switched off before a batch: it stops, nothing written; a version changed meanwhile: it stops (a newer pass follows)', async () => {
    const k = setup();
    k.deactivate();
    await k.job.run(payload);
    expect(k.repo.lockByFileIds).not.toHaveBeenCalled();
    expect(k.repo.upsertMany).not.toHaveBeenCalled();

    const k2 = setup();
    k2.uow.setLockTimeout.mockImplementationOnce(async () => {
      k2.versions.set(partId(1), live(partId(1), 'v2'));
    });
    await k2.job.run(payload);
    expect(k2.repo.upsertMany).not.toHaveBeenCalled();
    expect(k2.queue.enqueueFiles).not.toHaveBeenCalled();
  });

  it('no manifest yet: every known file is removed', async () => {
    const k = setup();
    k.versions.delete(HUB_MANIFEST);
    const row = {
      id: 'row-1',
      fileId: fileId(1),
      parts: [],
    } as unknown as CloudFile;
    k.repo.listForSpace.mockResolvedValueOnce([row]);
    k.repo.lockByFileIds.mockResolvedValueOnce([row]);
    await k.job.run(payload);
    expect(k.repo.deleteByIds).toHaveBeenCalledWith(ORG, ['row-1']);
  });
});
