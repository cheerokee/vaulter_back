/** Limits of the conversations module (spec 2026-11-09-conversations §4.7; values fixed in the plan). */

/** Largest encrypted message body (bytes of the blob, not of the base64url text). Bigger content goes as an attachment. */
export const MAX_MESSAGE_BYTES = 65_536;
/** Largest encrypted header (title, plan...). */
export const MAX_HEADER_BYTES = 16_384;
/** Largest encrypted attachment (100 MiB). */
export const MAX_ATTACHMENT_BYTES = 104_857_600;
/** Live participants per conversation (people; the executor does not count). */
export const MAX_CONVERSATION_PARTICIPANTS = 50;
/** A tombstoned message or conversation keeps its encrypted content this long; then a routine nulls it. */
export const CONVERSATION_RETENTION_DAYS = 30;
/** Smallest encrypted blob: version byte (1) + nonce (24) + Poly1305 tag (16), empty plaintext (docs/crypto/conversations.md). */
export const ENCRYPTED_BLOB_OVERHEAD_BYTES = 41;
/** Largest page of the conversation feeds (`GET /conversations/changes`, `GET /hub/conversations/changes`). */
export const CONVERSATION_SYNC_MAX_LIMIT = 500;
/** Longest wait of the executor's long poll (`wait` of `GET /hub/conversations/changes`), in seconds. */
export const CONVERSATION_LONG_POLL_MAX_SECONDS = 25;
/**
 * Long polls waiting at once (per API instance): per Hub (one loop, plus one overlapping while it reconnects) and in
 * total. Over either cap the request does not wait (it answers the read at once): a waiting request holds no database
 * connection, only memory and a socket, so the global cap bounds those and the wake fan-out.
 */
export const CONVERSATION_LONG_POLLS_PER_HUB = 2;
export const CONVERSATION_LONG_POLLS_TOTAL = 1_000;
/** Without the LISTEN connection (database down or reconnecting), a waiting long poll re-reads at this interval. */
export const CONVERSATION_LONG_POLL_DEGRADED_REREAD_MS = 5_000;
/** Attachments purged per "empty the conversation's trash" request (one S3 `DeleteObjects` call). */
export const MAX_CONVERSATION_PURGE_ATTACHMENTS = 1_000;
