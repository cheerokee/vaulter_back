import type { KeysetSlice } from '../../../shared/domain/pagination.js';

/** A committed version as the listings show it (`versionId` = the `uploadId` of its intent). */
export type ListedVersion = {
  versionId: string;
  keyVersion: number;
  sizeBytes: number;
  sha256: string;
  /** When the version was committed (`committed_at`). */
  uploadedAt: Date;
};

/** An object of the index: live with its current version, or a tombstone. */
export type ListedObject = {
  objectId: string;
  deleted: boolean;
  deletedAt: Date | null;
  /**
   * `current`: the live version (null on a tombstone); `trash`: the last version, the one in the trash. Never a
   * pending intent.
   */
  currentVersion: ListedVersion | null;
};

/** A stored (committed, inside the trash window) version of one object. */
export type StoredObjectVersion = ListedVersion & {
  objectId: string;
  /** When it left the live state (replaced or deleted); null for the live version. */
  supersededAt: Date | null;
  /** Whether it is the live version of a live object. */
  current: boolean;
};

export type ObjectListing = { include: 'current' | 'trash'; since?: Date };

/**
 * Port: read-only queries of the backup index (no locks; each one in the organization's RLS scope). `asOf` is the
 * database clock when the query ran (`now()` of its transaction), for the next `since`. Rows come in id order, at most
 * `slice.limit + 1` of them (the extra row only says there is a next page). Everything uses the index's own
 * `s3_version_id`, never S3's "current" version.
 */
export abstract class BackupIndexReader {
  /**
   * `current` without `since`: the live objects (committed current version, no tombstone). With `since`: every object
   * whose index row changed at or after it, tombstones included (`deleted`, no version). `trash`: objects deleted in
   * the last 30 days (database clock) with their last version. An object whose upload was never confirmed never
   * appears.
   */
  abstract listObjects(
    orgId: string,
    spaceId: string,
    listing: ObjectListing,
    slice: KeysetSlice,
  ): Promise<{ rows: ListedObject[]; asOf: Date }>;
  /** The committed versions of the object still inside the trash window (live one included), in id (time) order. */
  abstract listVersions(
    orgId: string,
    spaceId: string,
    objectId: string,
    slice: KeysetSlice,
  ): Promise<{ rows: StoredObjectVersion[]; asOf: Date }>;
  /**
   * The S3 version id of a committed version of this object of this space, live or still inside the 30-day trash
   * (database clock); null otherwise (unknown, pending, expired, another object or space, out of the trash).
   */
  abstract downloadableS3VersionId(
    orgId: string,
    spaceId: string,
    objectId: string,
    versionId: string,
  ): Promise<string | null>;
}
