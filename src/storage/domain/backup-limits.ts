// Valores do backup (spec storage-backup §2, §4.2, §4.8). Mudar qualquer um é decisão de produto.

/** Biggest object (encrypted blob): the hub splits bigger files. */
export const MAX_OBJECT_BYTES = 5_368_709_120; // 5 GiB
/**
 * Declared bytes one confirmation may copy (the objects not committed yet). The server-side copies run under the space
 * and object locks while holding a pool connection, so one request must not hold them for an unbounded S3 time:
 * above it, 422 `confirm-batch-too-large` (the client confirms in smaller batches). One object always fits.
 */
export const MAX_CONFIRM_BATCH_BYTES = MAX_OBJECT_BYTES;
/**
 * Longest wait for a row lock (space or objects) in an upload intent, confirmation or delete (`lock_timeout`, SET
 * LOCAL by `StorageAccess.lock`): past it, 409 `storage-busy` (retryable) instead of a request (and its pool
 * connection) waiting behind a long confirmation.
 */
export const STORAGE_LOCK_TIMEOUT_MS = 10_000;
/** Items per upload intent, confirmation or delete request. */
export const MAX_BATCH_ITEMS = 100;
/** Validity of a presigned URL. */
export const PRESIGNED_URL_TTL_SECONDS = 15 * 60;
/**
 * How long an upload intent reserves space and can be confirmed: the provisional object lives 1 day in the bucket
 * (lifecycle rule on the `stage=upload` tag), so the reservation lives as long. A new intent for the same object by
 * the same uploader ends the previous ones (a retrying hub never reserves twice).
 */
export const UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Old and deleted versions stay recoverable (and counted in the usage) this long. */
export const TRASH_DAYS = 30;
/** Biggest page of an index listing (a restoring hub lists the whole space). */
export const MAX_LIST_LIMIT = 1000;
/**
 * Longest time from the index writes of a confirmation/delete (which stamp `storage_objects.updated_at` with the
 * database clock, after all S3 work) to its COMMIT: past it the transaction is killed (`transaction_timeout`) and never
 * commits. Bounds how far behind a committed `updated_at` can be, so the 1-hour `since` overlap of the listing holds.
 * Relies on the database `transaction_timeout` being 0 globally (see `UnitOfWork.limitRemainingTime`).
 */
export const INDEX_TAIL_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Old (superseded) versions kept per object (decisão do Jonas, 2026-11-09): when a confirmation makes a new current
 * version, the superseded versions of that object beyond the 10 most recent (by `superseded_at`) are purged. A deleted
 * object keeps its versions for the full 30 days (no cap on delete).
 */
export const MAX_TRASH_VERSIONS_PER_OBJECT = 10;
/**
 * Versions one "empty the trash" request purges at most (`POST /spaces/:id/backup/trash/empty`): the app repeats
 * while `remainingVersions > 0`. Bounds the object locks and the S3 deletes of one request.
 */
export const MAX_PURGE_BATCH_VERSIONS = 1000;
