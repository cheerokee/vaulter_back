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

  /** Presigned GET of one specific version. */
  abstract presignGet(
    key: string,
    versionId: string,
    expiresInSeconds: number,
  ): Promise<string>;

  /** Current version of the key, or null when there is none (missing or behind a delete marker). */
  abstract head(key: string): Promise<ObjectHead | null>;

  /** Server-side copy into a new version of `toKey` (sha256 recomputed, upload tag dropped). */
  abstract copy(fromKey: string, toKey: string): Promise<{ versionId: string }>;

  /** Hides the current version behind a delete marker; older versions stay readable by versionId. */
  abstract deleteCurrent(
    key: string,
  ): Promise<{ deleteMarkerVersionId: string }>;
}
