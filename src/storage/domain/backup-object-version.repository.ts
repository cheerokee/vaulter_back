import type {
  BackupObjectVersion,
  BackupUploader,
} from './backup-object-version.js';

/** Every method takes `orgId` first (RLS context and filter). */
export abstract class BackupObjectVersionRepository {
  abstract create(version: BackupObjectVersion): Promise<void>;
  /** Writes the status, the S3 version id and the commit time. */
  abstract save(version: BackupObjectVersion): Promise<void>;
  /** The versions of `ids` in this space (any status); ids of other spaces, organizations or unknown are absent. */
  abstract findByIds(
    orgId: string,
    spaceId: string,
    ids: readonly string[],
  ): Promise<BackupObjectVersion[]>;
  /** Ends the pending intents of the object by the same uploader (status `expired`); returns how many. */
  abstract expirePending(
    orgId: string,
    spaceId: string,
    objectId: string,
    uploader: BackupUploader,
  ): Promise<number>;
  /** Marks the versions as superseded at `now` (only those not superseded yet): they go to the 30-day trash. */
  abstract markSuperseded(
    orgId: string,
    versionIds: readonly string[],
    now: Date,
  ): Promise<void>;
  /**
   * Usage of the space, in bytes: committed versions that are current or were superseded less than 30 days ago
   * (trash included), plus the pending intents still inside their window (reservations).
   */
  abstract usedBytes(orgId: string, spaceId: string): Promise<number>;
}
