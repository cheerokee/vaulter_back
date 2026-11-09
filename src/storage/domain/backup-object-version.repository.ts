import type {
  BackupObjectVersion,
  BackupUploader,
  PurgedVersion,
} from './backup-object-version.js';
import type { SupersededVersion } from './trash-rules.js';

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
  /**
   * Marks the versions as superseded (only those not superseded yet), on the database clock like the trash window:
   * they go to the 30-day trash.
   */
  abstract markSuperseded(
    orgId: string,
    versionIds: readonly string[],
  ): Promise<void>;
  /**
   * Usage of the space, in bytes: committed versions that are current or were superseded less than 30 days ago
   * (trash included), plus the pending intents still inside their window (reservations).
   */
  abstract usedBytes(orgId: string, spaceId: string): Promise<number>;

  // Lixeira (spec storage-backup §4.8, "Controle da lixeira"). A lixeira = versões `committed` substituídas há menos de
  // 30 dias (relógio do banco); `purged` sai do uso, das listagens e dos downloads.

  /** Bytes and count of the trash of the space (superseded committed versions inside the 30-day window). */
  abstract trashUsage(
    orgId: string,
    spaceId: string,
  ): Promise<{ versions: number; bytes: number }>;
  /** The trash versions of one object (superseded, committed, inside the 30-day window), any order. */
  abstract supersededInTrash(
    orgId: string,
    objectId: string,
  ): Promise<SupersededVersion[]>;
  /**
   * Candidates of "empty the trash": at most `limit` trash versions of the space, in (object id, id) order. No lock:
   * the caller locks the objects and `markPurged` re-checks.
   */
  abstract trashCandidates(
    orgId: string,
    spaceId: string,
    limit: number,
  ): Promise<{ id: string; objectId: string }[]>;
  /**
   * Purges `versionIds` of this space in the index: only rows still `committed` and superseded, and never the current
   * version of a live object. Status `purged`, `purged_at` on the database clock and a journal mark
   * (`s3_write_started_at`, renewed to now()): the S3 deletes come after the COMMIT, so the mark lets the reconcile
   * sweep remove the S3 version if they never happen. Returns the rows actually purged.
   */
  abstract markPurged(
    orgId: string,
    spaceId: string,
    versionIds: readonly string[],
  ): Promise<PurgedVersion[]>;

  // Diário das gravações no S3 (`s3_write_started_at`). Uma marca quer dizer "alguma tentativa de gravar no S3 por
  // esta linha começou neste instante ou depois" (relógio do BANCO). Gravada numa transação curta ANTES do unit of work
  // que grava no S3 (nunca uma segunda conexão enquanto se segura outra), sempre renovada para now(), NUNCA limpa no
  // commit: só a varredura limpa, e só marcas mais antigas que o limite, depois de reparar o objeto sob a trava.

  /**
   * Marks the PENDING versions `versionIds` of the space uploaded by `uploader` (only the caller's own intents) with
   * the database clock; returns the stored mark of each marked row (this attempt's `markedAt`).
   */
  abstract markPendingWrites(
    orgId: string,
    spaceId: string,
    versionIds: readonly string[],
    uploader: BackupUploader,
  ): Promise<Map<string, Date>>;
  /**
   * Marks the live (committed, not superseded) versions `items[].versionId` of their objects (a delete is about to
   * start); returns the stored mark of each marked row.
   */
  abstract markLiveWrites(
    orgId: string,
    spaceId: string,
    items: readonly { objectId: string; versionId: string }[],
  ): Promise<Map<string, Date>>;
  /** Current marks of these versions (rows without a mark are absent). */
  abstract writeMarks(
    orgId: string,
    versionIds: readonly string[],
  ): Promise<Map<string, Date>>;
  /** Whether a version of the object carries a mark older than `before` (another, earlier attempt). */
  abstract hasWriteMarksBefore(
    orgId: string,
    objectId: string,
    before: Date,
  ): Promise<boolean>;
  /** Sweep only: clears the object's marks older than `olderThanMinutes` (database clock). */
  abstract clearWriteMarks(
    orgId: string,
    objectId: string,
    olderThanMinutes: number,
  ): Promise<void>;
  /** S3 version ids referenced by the committed versions of the object (trash included). */
  abstract committedS3VersionIds(
    orgId: string,
    objectId: string,
  ): Promise<string[]>;
  /** Objects (any organization) with a mark older than `olderThanMinutes` (database clock), in the reconcile context. */
  abstract staleWriteMarks(
    olderThanMinutes: number,
  ): Promise<{ organizationId: string; spaceId: string; objectId: string }[]>;
}
