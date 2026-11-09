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

  // Diário das gravações no S3 (`s3_write_started_at`) e reparo do bucket. A marca é uma dica "talvez haja uma gravação
  // no S3 que o índice não tem": gravada numa transação curta ANTES do unit of work que grava no S3 (nunca uma segunda
  // conexão enquanto se segura outra), mantida se ele falhar, limpa só pelo commit que confirma aquela linha ou pela
  // varredura (marcas antigas). Marcar não sobrescreve uma marca mais antiga (COALESCE): ela pode ser de uma tentativa
  // que caiu depois de gravar no S3.

  /** Marks the PENDING versions `versionIds` of the space (a confirmation is about to copy them). */
  abstract markVersionsWriteStarted(
    orgId: string,
    spaceId: string,
    versionIds: readonly string[],
    at: Date,
  ): Promise<void>;
  /** Marks the live (committed, not superseded) version of each object of the space (a delete is about to start). */
  abstract markObjectsWriteStarted(
    orgId: string,
    spaceId: string,
    objectIds: readonly string[],
    at: Date,
  ): Promise<void>;
  /** Whether a version of the object carries a mark older than `before` (another, earlier attempt). */
  abstract hasWriteMarksBefore(
    orgId: string,
    objectId: string,
    before: Date,
  ): Promise<boolean>;
  /** Clears the marks of these versions (their S3 write is now in the index). */
  abstract clearVersionMarks(
    orgId: string,
    versionIds: readonly string[],
  ): Promise<void>;
  /** Clears the object's marks older than `before` (the sweep repaired it; fresher marks stay). */
  abstract clearWriteMarks(
    orgId: string,
    objectId: string,
    before: Date,
  ): Promise<void>;
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
