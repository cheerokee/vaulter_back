// Valores do backup (spec storage-backup §2, §4.2, §4.8). Mudar qualquer um é decisão de produto.

/** Biggest object (encrypted blob): the hub splits bigger files. */
export const MAX_OBJECT_BYTES = 5_368_709_120; // 5 GiB
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
 */
export const INDEX_TAIL_TIMEOUT_MS = 5 * 60 * 1000;
