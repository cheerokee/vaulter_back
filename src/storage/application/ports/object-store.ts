export interface PresignPutInput {
  /** Exact size of the (encrypted) body, in bytes. */
  sizeBytes: number;
  /** Hex sha256 (64 lowercase chars) of the exact body. */
  sha256Hex: string;
  expiresInSeconds: number;
}

export interface PresignedPut {
  url: string;
  /**
   * Headers the client must send verbatim with the PUT. They are part of the signature (size, checksum and the
   * `stage=upload` tag that drives the 1-day lifecycle rule), so changing or omitting any of them is refused.
   */
  headers: Record<string, string>;
}

/** One version of one key, to delete for good. */
export interface VersionRef {
  key: string;
  versionId: string;
}

/** One stored version of a key (an object version or a delete marker). */
export interface StoredVersion {
  versionId: string;
  isDeleteMarker: boolean;
}

export interface ObjectHead {
  sizeBytes: number;
  /** Hex sha256 stored by S3 for the current version; null when S3 has no full-object sha256 (e.g. multipart). */
  sha256Hex: string | null;
  versionId: string | null;
}

/**
 * Port: the object bucket (`S3_BUCKET_HUB_BRAIN`, versioned). Keys follow `orgs/<orgId>/spaces/<spaceId>/...`; the
 * bytes never pass through the backend (presigned URLs), which only checks sizes and checksums.
 */
export abstract class ObjectStore {
  /** Presigned PUT bound to the declared size and sha256: S3 refuses other bytes. Marks the object as a provisional upload. */
  abstract presignPut(
    key: string,
    input: PresignPutInput,
  ): Promise<PresignedPut>;

  /**
   * The SERVER uploads bytes itself to a provisional key (same checksum and `stage=upload` tag as a presigned PUT): for
   * what the server writes to the backup (active cloud documents and the cloud manifest, `ServerBackupWriter`). The
   * confirmation then copies it like any client upload.
   */
  abstract put(key: string, body: Uint8Array, sha256Hex: string): Promise<void>;

  /** Presigned GET of one specific version. */
  abstract presignGet(
    key: string,
    versionId: string,
    expiresInSeconds: number,
  ): Promise<string>;

  /**
   * The bytes of ONE specific version (never "the current one": the index says which version is the truth). Refuses a
   * body larger than `maxBytes` before reading it (`ObjectTooLargeToReadError`). For the server's own reads of the
   * backup (active cloud indexing); clients download through presigned URLs.
   */
  abstract getVersion(
    key: string,
    versionId: string,
    maxBytes: number,
  ): Promise<Uint8Array>;

  /** Current version of the key, or null when there is none (missing or behind a delete marker). */
  abstract head(key: string): Promise<ObjectHead | null>;

  /** Server-side copy into a new version of `toKey` (sha256 recomputed, upload tag dropped). */
  abstract copy(fromKey: string, toKey: string): Promise<{ versionId: string }>;

  /** Hides the current version behind a delete marker; older versions stay readable by versionId. */
  abstract deleteCurrent(
    key: string,
  ): Promise<{ deleteMarkerVersionId: string }>;

  /**
   * Permanently removes ONE version (or delete marker) of the key; the previous version becomes current again.
   * Only for repair (`BackupObjectHealer`): removing a copy or a delete marker that no committed index row references,
   * so the bucket's current version keeps matching the index (a noncurrent version expires in 30 days).
   */
  abstract deleteVersion(key: string, versionId: string): Promise<void>;

  /**
   * Permanently removes many versions in batched calls (S3 `DeleteObjects`, up to 1000 per call): only for the trash
   * purge (`BackupTrash`), of versions the index already marked `purged`. Never throws: returns the versions that were
   * NOT deleted (per-key errors, or every version of a batch whose call failed); their journal marks stay, so the
   * reconcile sweep removes them later. Deleting a version that no longer exists counts as deleted.
   */
  abstract deleteVersions(
    versions: readonly VersionRef[],
  ): Promise<{ failed: VersionRef[] }>;

  /** Every version and delete marker of exactly this key (any order). */
  abstract listVersions(key: string): Promise<StoredVersion[]>;
}

/** `ObjectStore.getVersion` of a body bigger than the caller accepts (nothing was read). */
export class ObjectTooLargeToReadError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly maxBytes: number,
  ) {
    super(`object has ${sizeBytes} bytes, more than ${maxBytes}`);
    this.name = 'ObjectTooLargeToReadError';
  }
}
