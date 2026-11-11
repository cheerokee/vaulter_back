import type { UnitOfWork } from '../../../shared/infra/db/unit-of-work.js';
import type { SpaceCloud } from '../../../spaces/application/space-cloud.js';
import { AiPricing } from '../../domain/ai-pricing.js';
import type { CloudFile } from '../../domain/cloud-file.js';
import type {
  CloudChunkRepository,
  CloudFileRepository,
} from '../../domain/indexing.repositories.js';
import { FakeEmbedder } from '../../testing/fake-embedder.js';
import { BackupObjectOpenError } from '../ports/backup-object-opener.js';
import type { IndexingCostMeter } from '../ports/indexing-cost-meter.js';
import type { TextExtractor } from '../ports/text-extractor.js';
import type { BackupPlaintextReader } from './backup-plaintext-reader.js';
import { IndexFileJob, IndexingAbortedError } from './index-file.job.js';
import type { SpaceKeyOpener } from './space-keys.js';

const ORG = 'org';
const SPACE = 'space';
const FILE: CloudFile = {
  id: 'row-1',
  organizationId: ORG,
  spaceId: SPACE,
  fileId: 'file-1',
  manifest: 'hub',
  name: 'secret name.txt',
  path: null,
  mediaType: 'text/plain',
  source: { kind: 'file' },
  modifiedAt: null,
  parts: [
    { objectId: 'p1', versionId: 'v1' },
    { objectId: 'p2', versionId: 'v2' },
  ],
  status: 'pending',
  skipReason: null,
  embeddingModel: null,
  chunkCount: 0,
  indexedAt: null,
};
const live = (objectId: string, versionId: string, sizeBytes = 100) => ({
  objectId,
  versionId,
  keyVersion: 1,
  sizeBytes,
  sha256: 'x',
  uploadedAt: new Date(),
  s3VersionId: `s3-${versionId}`,
});
const PAYLOAD = { organizationId: ORG, spaceId: SPACE, cloudFileId: 'row-1' };

function setup(text = 'word '.repeat(40 * 50)) {
  const trace: string[] = [];
  const key = new Uint8Array(32).fill(9);
  const plaintexts: Uint8Array[] = [];
  let active = true;
  const spaceCloud = {
    modeOf: vi.fn(async () => 'active_cloud'),
    lockActiveForWrite: vi.fn(async () => {
      trace.push('lockActiveForWrite');
      return active;
    }),
  };
  const keys = { get: vi.fn(async () => key), wipe: vi.fn(() => key.fill(0)) };
  const keyOpener = { forSpace: vi.fn(async () => keys) };
  const reader = {
    liveVersions: vi.fn(
      async () =>
        new Map([
          ['p1', live('p1', 'v1')],
          ['p2', live('p2', 'v2')],
        ]),
    ),
    open: vi.fn(async (_o: string, _s: string, v: { objectId: string }) => {
      const half = text.length / 2;
      const part = new TextEncoder().encode(
        v.objectId === 'p1' ? text.slice(0, half) : text.slice(half),
      );
      plaintexts.push(part);
      return part;
    }),
  };
  const extractor = {
    supports: vi.fn((t: string) => t === 'text/plain'),
    extract: vi.fn(async (_t: string, bytes: Uint8Array) => ({
      kind: 'text' as const,
      text: new TextDecoder().decode(bytes),
      truncated: false,
    })),
  };
  const embedder = new FakeEmbedder();
  const meter = {
    beforeBatch: vi.fn(async () => trace.push('beforeBatch')),
    record: vi.fn(async () => trace.push('record')),
  };
  const files = {
    findById: vi.fn(async () => ({ ...FILE })),
    lockById: vi.fn(async () => {
      trace.push('lockById');
      return { ...FILE };
    }),
    upsert: vi.fn(async (f: CloudFile) => trace.push(`upsert:${f.status}`)),
  };
  const chunks = {
    replaceForFile: vi.fn(async () => trace.push('replaceForFile')),
    deleteForFile: vi.fn(async () => trace.push('deleteForFile')),
  };
  const uow = {
    run: vi.fn(async (fn: () => Promise<unknown>) => {
      trace.push('run');
      const r = await fn();
      trace.push('commit');
      return r;
    }),
  };
  const job = new IndexFileJob(
    spaceCloud as unknown as SpaceCloud,
    keyOpener as unknown as SpaceKeyOpener,
    reader as unknown as BackupPlaintextReader,
    extractor as unknown as TextExtractor,
    embedder,
    meter as unknown as IndexingCostMeter,
    new AiPricing(),
    files as unknown as CloudFileRepository,
    chunks as unknown as CloudChunkRepository,
    uow as unknown as UnitOfWork,
  );
  return {
    job,
    trace,
    key,
    plaintexts,
    spaceCloud,
    reader,
    extractor,
    embedder,
    meter,
    files,
    chunks,
    deactivate: () => {
      active = false;
    },
  };
}

describe('IndexFileJob', () => {
  it('reads the parts in order, embeds in batches through the cost meter, then writes under the space lock', async () => {
    const k = setup();
    await k.job.run(PAYLOAD);
    // 2000 words of 5 chars = 10000 chars -> 13 chunks of <= 800 -> one batch of 32.
    expect(k.embedder.calls).toEqual([{ count: 13, kind: 'document' }]);
    expect(k.meter.record).toHaveBeenCalledWith(
      { organizationId: ORG, spaceId: SPACE, cloudFileId: 'row-1' },
      expect.objectContaining({
        model: 'fake-embedding',
        costMicroUsd: expect.any(BigInt),
      }),
    );
    expect(k.trace).toEqual([
      'beforeBatch',
      'record',
      'run',
      'lockActiveForWrite',
      'lockById',
      'replaceForFile',
      'upsert:indexed',
      'commit',
    ]);
    const [, model, chunks] = k.chunks.replaceForFile.mock
      .calls[0] as unknown as [CloudFile, string, { position: number }[]];
    expect(model).toBe('fake-embedding');
    expect(chunks.map((c) => c.position)).toEqual([...Array(13).keys()]);
    // Keys and decrypted parts wiped.
    expect(k.key.every((b) => b === 0)).toBe(true);
    for (const p of k.plaintexts) expect(p.every((b) => b === 0)).toBe(true);
  });

  it('switched off while embedding (key already opened): nothing is written (Review Focus 1)', async () => {
    const k = setup();
    k.meter.beforeBatch.mockImplementationOnce(async () => {
      k.deactivate();
      return k.trace.push('beforeBatch (switched off meanwhile)');
    });
    await k.job.run(PAYLOAD);
    expect(k.trace).toEqual([
      'beforeBatch (switched off meanwhile)',
      'record',
      'run',
      'lockActiveForWrite',
      'commit',
    ]);
    expect(k.files.lockById).not.toHaveBeenCalled();
    expect(k.chunks.replaceForFile).not.toHaveBeenCalled();
    expect(k.files.upsert).not.toHaveBeenCalled();
    expect(k.key.every((b) => b === 0)).toBe(true);
  });

  it('a file changed meanwhile (another version listed) or no longer pending: nothing written', async () => {
    const k = setup();
    k.files.lockById.mockResolvedValueOnce({
      ...FILE,
      parts: [{ objectId: 'p1', versionId: 'v9' }],
    });
    await k.job.run(PAYLOAD);
    expect(k.chunks.replaceForFile).not.toHaveBeenCalled();
    const k2 = setup();
    k2.files.findById.mockResolvedValueOnce({ ...FILE, status: 'indexed' });
    await k2.job.run(PAYLOAD);
    expect(k2.reader.liveVersions).not.toHaveBeenCalled();
  });

  it('a part in another version than the row: stops before reading anything', async () => {
    const k = setup();
    k.reader.liveVersions.mockResolvedValueOnce(
      new Map([['p1', live('p1', 'v1')]]),
    );
    await k.job.run(PAYLOAD);
    expect(k.reader.open).not.toHaveBeenCalled();
    expect(k.trace).toEqual([]);
  });

  it.each([
    ['unsupported format', 'unsupported-format'],
    ['too large', 'too-large'],
    ['does not open', 'unreadable'],
    ['empty text', 'empty'],
  ])(
    '%s: skipped with the reason, old chunks removed, never embedded',
    async (what, reason) => {
      const k = setup(what === 'empty text' ? '   ' : undefined);
      if (what === 'unsupported format') {
        k.files.findById.mockResolvedValueOnce({
          ...FILE,
          mediaType: 'image/png',
        });
        k.files.lockById.mockResolvedValueOnce({
          ...FILE,
          mediaType: 'image/png',
        });
      }
      if (what === 'too large') {
        k.reader.liveVersions.mockResolvedValueOnce(
          new Map([
            ['p1', live('p1', 'v1', 60 * 1024 * 1024)],
            ['p2', live('p2', 'v2', 60 * 1024 * 1024)],
          ]),
        );
      }
      if (what === 'does not open') {
        k.reader.open.mockRejectedValueOnce(
          new BackupObjectOpenError('authentication-failed'),
        );
      }
      await k.job.run(PAYLOAD);
      expect(k.embedder.calls).toEqual([]);
      expect(k.chunks.deleteForFile).toHaveBeenCalled();
      expect(k.files.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'skipped',
          skipReason: reason,
          chunkCount: 0,
        }),
      );
      // Opened only when the bytes had to be read (and then wiped).
      const opened = what === 'does not open' || what === 'empty text';
      expect(k.key.every((b) => b === 0)).toBe(opened);
    },
  );

  it('an aborted job (worker stopping) throws before writing; the space not active: nothing at all', async () => {
    const k = setup();
    const ctl = new AbortController();
    ctl.abort();
    await expect(k.job.run(PAYLOAD, ctl.signal)).rejects.toBeInstanceOf(
      IndexingAbortedError,
    );
    expect(k.files.upsert).not.toHaveBeenCalled();
    const k2 = setup();
    k2.spaceCloud.modeOf.mockResolvedValueOnce('encrypted_backup');
    await k2.job.run(PAYLOAD);
    expect(k2.reader.liveVersions).not.toHaveBeenCalled();
  });
});
