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

  // Diário das gravações no S3 (`s3_write_started_at`) e reparo do bucket.

  /**
   * Marks that an S3 write (copy or delete marker) for these versions is about to start. Called through
   * `UnitOfWork.detached` (autocommit) so the mark survives a rollback of the unit of work.
   */
  abstract markWriteStarted(
    orgId: string,
    versionIds: readonly string[],
  ): Promise<void>;
  /** Whether any version of the object still carries a write mark (an S3 write that may not be in the index). */
  abstract hasWriteMarks(orgId: string, objectId: string): Promise<boolean>;
  /** Clears every write mark of the object (its index state is now the truth). */
  abstract clearWriteMarks(orgId: string, objectId: string): Promise<void>;
  /** S3 version ids referenced by the committed versions of the object (trash included). */
  abstract committedS3VersionIds(
    orgId: string,
    objectId: string,
  ): Promise<string[]>;
  /** Objects (any organization) with a write mark older than `before`: read in the reconcile context. */
  abstract staleWriteMarks(
    before: Date,
  ): Promise<{ organizationId: string; spaceId: string; objectId: string }[]>;
}
