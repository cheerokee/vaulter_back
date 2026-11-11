import type {
  ManifestFile,
  ManifestSource,
  ManifestWriter,
} from './space-manifest.js';

export type CloudFileStatus = 'pending' | 'indexed' | 'skipped';

/** Why a file has no chunks. Codes only (they go to logs). */
export type CloudFileSkipReason =
  'missing-parts' | 'unsupported-format' | 'too-large' | 'unreadable' | 'empty';

export type FilePart = { objectId: string; versionId: string };

/**
 * A file of an active-cloud space as the cloud knows it (`cloud_files`): what the manifest says (legible: name, path)
 * and which backup versions of its parts were (or will be) indexed. Deleted for real when the cloud is switched off.
 */
export type CloudFile = {
  id: string;
  organizationId: string;
  spaceId: string;
  fileId: string;
  manifest: ManifestWriter;
  name: string;
  path: string | null;
  mediaType: string;
  source: ManifestSource;
  modifiedAt: Date | null;
  /** Parts in order, with the backup version each one had when listed. */
  parts: FilePart[];
  status: CloudFileStatus;
  skipReason: CloudFileSkipReason | null;
  embeddingModel: string | null;
  chunkCount: number;
  indexedAt: Date | null;
};

/** A file the manifests list now, with the live version of each part (`null`: a part is missing or deleted). */
export type DesiredFile = {
  entry: ManifestFile;
  manifest: ManifestWriter;
  parts: FilePart[] | null;
};

export type IndexSyncPlan = {
  /** Files no manifest lists any more: deleted with their chunks. */
  remove: CloudFile[];
  /** New or changed rows to write (status already set). */
  upsert: CloudFile[];
  /** Rows whose chunks must go now (a part went missing). */
  clearChunks: CloudFile[];
  /** Row ids whose indexing job must be enqueued (status `pending`). */
  enqueue: string[];
};

export const sameParts = (a: FilePart[], b: FilePart[]): boolean =>
  a.length === b.length &&
  a.every(
    (p, i) => p.objectId === b[i]!.objectId && p.versionId === b[i]!.versionId,
  );

const sameSource = (a: ManifestSource, b: ManifestSource): boolean =>
  a.kind === b.kind &&
  (a.kind !== 'connector' ||
    (b.kind === 'connector' && a.connector === b.connector));

const sameMetadata = (row: CloudFile, d: DesiredFile): boolean =>
  row.manifest === d.manifest &&
  row.name === d.entry.name &&
  row.path === d.entry.path &&
  row.mediaType === d.entry.mediaType &&
  sameSource(row.source, d.entry.source) &&
  (row.modifiedAt?.getTime() ?? null) ===
    (d.entry.modifiedAt?.getTime() ?? null);

/**
 * Both manifests merged by `fileId`: the Hub's entry wins over the cloud's (a cloud document the Hub already
 * incorporated, before the server removes it from the cloud manifest).
 */
export function mergeManifests(
  hub: readonly ManifestFile[],
  cloud: readonly ManifestFile[],
): { entry: ManifestFile; manifest: ManifestWriter }[] {
  const out = new Map<
    string,
    { entry: ManifestFile; manifest: ManifestWriter }
  >();
  for (const entry of cloud)
    out.set(entry.fileId, { entry, manifest: 'cloud' });
  for (const entry of hub) out.set(entry.fileId, { entry, manifest: 'hub' });
  return [...out.values()];
}

/**
 * What a reindexing pass does (spec active-cloud §4.2, "incremental"): a file whose parts kept the same backup
 * versions keeps its chunks (only metadata changes are written); a new file, one with any part in a new version, or a
 * skipped one whose media type changed goes `pending` (its job replaces its chunks, keeping the old ones until then); a
 * file with a missing part loses its chunks now (`skipped`, `missing-parts`) until the part arrives; a file no manifest
 * lists is deleted. A file still `pending` is enqueued again (its job may have been lost).
 */
export function planIndexSync(
  scope: { organizationId: string; spaceId: string },
  existing: readonly CloudFile[],
  desired: readonly DesiredFile[],
  newId: () => string,
): IndexSyncPlan {
  const byFileId = new Map(existing.map((f) => [f.fileId, f]));
  const plan: IndexSyncPlan = {
    remove: [],
    upsert: [],
    clearChunks: [],
    enqueue: [],
  };
  const kept = new Set<string>();
  for (const d of desired) {
    const row = byFileId.get(d.entry.fileId);
    kept.add(d.entry.fileId);
    const next: CloudFile = {
      id: row?.id ?? newId(),
      organizationId: scope.organizationId,
      spaceId: scope.spaceId,
      fileId: d.entry.fileId,
      manifest: d.manifest,
      name: d.entry.name,
      path: d.entry.path,
      mediaType: d.entry.mediaType,
      source: d.entry.source,
      modifiedAt: d.entry.modifiedAt,
      parts: row?.parts ?? [],
      status: row?.status ?? 'pending',
      skipReason: row?.skipReason ?? null,
      embeddingModel: row?.embeddingModel ?? null,
      chunkCount: row?.chunkCount ?? 0,
      indexedAt: row?.indexedAt ?? null,
    };
    if (d.parts === null) {
      const alreadyMissing =
        row?.status === 'skipped' && row.skipReason === 'missing-parts';
      if (alreadyMissing && sameMetadata(row, d)) continue;
      plan.upsert.push({
        ...next,
        parts: [],
        status: 'skipped',
        skipReason: 'missing-parts',
        embeddingModel: null,
        chunkCount: 0,
        indexedAt: null,
      });
      if (row && row.chunkCount > 0) plan.clearChunks.push(next);
      continue;
    }
    const unchanged =
      row !== undefined &&
      sameParts(row.parts, d.parts) &&
      (row.status !== 'skipped' ||
        (row.skipReason !== 'missing-parts' &&
          row.mediaType === d.entry.mediaType));
    if (unchanged) {
      if (!sameMetadata(row, d)) plan.upsert.push(next);
      if (row.status === 'pending') plan.enqueue.push(row.id);
      continue;
    }
    plan.upsert.push({
      ...next,
      parts: d.parts,
      status: 'pending',
      skipReason: null,
    });
    plan.enqueue.push(next.id);
  }
  for (const row of existing) {
    if (!kept.has(row.fileId)) plan.remove.push(row);
  }
  return plan;
}
