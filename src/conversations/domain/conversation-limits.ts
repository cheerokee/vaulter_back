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
