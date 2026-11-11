import {
  mergeManifests,
  planIndexSync,
  type CloudFile,
  type DesiredFile,
} from './cloud-file.js';
import type { ManifestFile } from './space-manifest.js';

const SCOPE = { organizationId: 'org', spaceId: 'space' };
let seq = 0;
const newId = () => `new-${++seq}`;

const entry = (
  fileId: string,
  over: Partial<ManifestFile> = {},
): ManifestFile => ({
  fileId,
  name: `${fileId}.pdf`,
  path: null,
  mediaType: 'application/pdf',
  source: { kind: 'file' },
  modifiedAt: null,
  parts: [`${fileId}-p1`],
  ...over,
});
const desired = (
  fileId: string,
  versionId: string | null,
  over: Partial<ManifestFile> = {},
): DesiredFile => ({
  entry: entry(fileId, over),
  manifest: 'hub',
  parts: versionId ? [{ objectId: `${fileId}-p1`, versionId }] : null,
});
const row = (
  fileId: string,
  versionId: string,
  over: Partial<CloudFile> = {},
): CloudFile => ({
  id: `row-${fileId}`,
  ...SCOPE,
  fileId,
  manifest: 'hub',
  name: `${fileId}.pdf`,
  path: null,
  mediaType: 'application/pdf',
  source: { kind: 'file' },
  modifiedAt: null,
  parts: [{ objectId: `${fileId}-p1`, versionId }],
  status: 'indexed',
  skipReason: null,
  embeddingModel: 'm',
  chunkCount: 3,
  indexedAt: new Date(),
  ...over,
});

describe('planIndexSync', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('a new file goes pending and is enqueued', () => {
    const plan = planIndexSync(SCOPE, [], [desired('a', 'v1')], newId);
    expect(plan.upsert).toHaveLength(1);
    expect(plan.upsert[0]).toMatchObject({
      id: 'new-1',
      organizationId: 'org',
      spaceId: 'space',
      status: 'pending',
      parts: [{ objectId: 'a-p1', versionId: 'v1' }],
    });
    expect(plan.enqueue).toEqual(['new-1']);
  });

  it('unchanged parts: nothing to do; a rename only rewrites metadata (no reindex)', () => {
    expect(
      planIndexSync(SCOPE, [row('a', 'v1')], [desired('a', 'v1')], newId),
    ).toEqual({
      remove: [],
      upsert: [],
      clearChunks: [],
      enqueue: [],
    });
    const renamed = planIndexSync(
      SCOPE,
      [row('a', 'v1')],
      [desired('a', 'v1', { name: 'new name.pdf' })],
      newId,
    );
    expect(renamed.upsert[0]).toMatchObject({
      name: 'new name.pdf',
      status: 'indexed',
    });
    expect(renamed.enqueue).toEqual([]);
  });

  it('a part in a new version reindexes only that file (old chunks kept until its job replaces them)', () => {
    const plan = planIndexSync(
      SCOPE,
      [row('a', 'v1'), row('b', 'v1')],
      [desired('a', 'v2'), desired('b', 'v1')],
      newId,
    );
    expect(plan.enqueue).toEqual(['row-a']);
    expect(plan.upsert).toEqual([
      expect.objectContaining({
        id: 'row-a',
        status: 'pending',
        chunkCount: 3,
      }),
    ]);
    expect(plan.clearChunks).toEqual([]);
  });

  it('a file no manifest lists is removed; a missing part clears its chunks now', () => {
    const plan = planIndexSync(
      SCOPE,
      [row('a', 'v1'), row('b', 'v1')],
      [desired('b', null)],
      newId,
    );
    expect(plan.remove.map((f) => f.id)).toEqual(['row-a']);
    expect(plan.clearChunks.map((f) => f.id)).toEqual(['row-b']);
    expect(plan.upsert[0]).toMatchObject({
      id: 'row-b',
      status: 'skipped',
      skipReason: 'missing-parts',
      chunkCount: 0,
      parts: [],
    });
    expect(plan.enqueue).toEqual([]);
    // Again: nothing new.
    const again = planIndexSync(
      SCOPE,
      [plan.upsert[0]!],
      [desired('b', null)],
      newId,
    );
    expect(again.upsert).toEqual([]);
    // The part arrives: pending.
    expect(
      planIndexSync(SCOPE, [plan.upsert[0]!], [desired('b', 'v1')], newId)
        .enqueue,
    ).toEqual(['row-b']);
  });

  it('skipped for its format: only a new version or a new media type retries it; pending is enqueued again', () => {
    const skipped = row('a', 'v1', {
      status: 'skipped',
      skipReason: 'unsupported-format',
      chunkCount: 0,
      mediaType: 'image/png',
    });
    expect(
      planIndexSync(
        SCOPE,
        [skipped],
        [desired('a', 'v1', { mediaType: 'image/png' })],
        newId,
      ).enqueue,
    ).toEqual([]);
    expect(
      planIndexSync(
        SCOPE,
        [skipped],
        [desired('a', 'v1', { mediaType: 'text/plain' })],
        newId,
      ).enqueue,
    ).toEqual(['row-a']);
    const pending = row('a', 'v1', { status: 'pending' });
    expect(
      planIndexSync(SCOPE, [pending], [desired('a', 'v1')], newId).enqueue,
    ).toEqual(['row-a']);
  });
});

describe('mergeManifests', () => {
  it("the Hub's entry wins over the cloud's for the same fileId", () => {
    const merged = mergeManifests(
      [entry('a', { name: 'hub' })],
      [entry('a', { name: 'cloud' }), entry('b')],
    );
    expect(
      merged.files.map((m) => [m.entry.fileId, m.manifest, m.entry.name]),
    ).toEqual([
      ['a', 'hub', 'hub'],
      ['b', 'cloud', 'b.pdf'],
    ]);
    expect(merged.droppedSharedParts).toBe(0);
  });

  it('guard: entries whose parts are also parts of another file are all dropped', () => {
    const merged = mergeManifests(
      [
        entry('a', { parts: ['x', 'shared'] }),
        entry('b', { parts: ['shared'] }),
        entry('c', { parts: ['y'] }),
      ],
      [entry('d', { parts: ['y'] })],
    );
    expect(merged.files.map((m) => m.entry.fileId)).toEqual([]);
    expect(merged.droppedSharedParts).toBe(4);
    const ok = mergeManifests([entry('a'), entry('b')], []);
    expect(ok.files).toHaveLength(2);
  });
});
