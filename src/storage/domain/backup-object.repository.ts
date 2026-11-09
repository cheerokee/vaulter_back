import type { BackupObject } from './backup-object.js';

/** Every method takes `orgId` first (RLS context and filter). REQUIRES an active unit of work for the locks. */
export abstract class BackupObjectRepository {
  /**
   * Creates the object row when it does not exist yet (no current version) and locks it `FOR UPDATE`, tombstoned
   * rows included. Null when the id is already used by another space or another organization (the caller answers
   * with a conflict, never a 500).
   */
  abstract lockOrCreate(
    orgId: string,
    spaceId: string,
    objectId: string,
  ): Promise<BackupObject | null>;
  /** `SELECT ... FOR UPDATE` of the object of this space, tombstoned rows included; null when unknown. */
  abstract lockForUpdate(
    orgId: string,
    spaceId: string,
    objectId: string,
  ): Promise<BackupObject | null>;
  /** Writes the current version and the tombstone. */
  abstract save(object: BackupObject): Promise<void>;
}
