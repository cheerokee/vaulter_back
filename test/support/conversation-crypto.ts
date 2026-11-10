import { getSodium } from '../../src/shared/infra/crypto/sodium.js';
import {
  generateSpaceKey,
  openSpaceKey,
  sealSpaceKey,
} from './client-crypto.js';
import { uuidBytes } from './hub-crypto.js';

/** Conversation encryption format. See docs/crypto/conversations.md. */
export type ConversationRecordContext = {
  spaceId: string;
  conversationId: string;
  /** Message id or attachment id; the header uses the conversation id. */
  recordId: string;
  keyVersion: number;
};

export type ConversationLabel =
  'conversation-header' | 'conversation-message' | 'conversation-attachment';

const FORMAT_VERSION = 1;
const NONCE_BYTES = 24;

/** The key of one conversation version: 32 random bytes (never the space key). */
export const newConversationKey = generateSpaceKey;

/** Sealed copy, same format as the space key copies: `0x01 ‖ crypto_box_seal`, 108 base64url chars. */
export const sealConversationKey = sealSpaceKey;
export const openConversationKey = openSpaceKey;

function conversationAd(
  label: ConversationLabel,
  ctx: ConversationRecordContext,
): Uint8Array {
  const prefix = new TextEncoder().encode(label);
  const ad = new Uint8Array(1 + prefix.length + 48 + 4);
  ad[0] = FORMAT_VERSION;
  ad.set(prefix, 1);
  ad.set(uuidBytes(ctx.spaceId), 1 + prefix.length);
  ad.set(uuidBytes(ctx.conversationId), 1 + prefix.length + 16);
  ad.set(uuidBytes(ctx.recordId), 1 + prefix.length + 32);
  new DataView(ad.buffer).setUint32(1 + prefix.length + 48, ctx.keyVersion);
  return ad;
}

async function seal(
  label: ConversationLabel,
  key: Uint8Array,
  ctx: ConversationRecordContext,
  plaintext: Uint8Array,
  nonce?: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const n = nonce ?? sodium.randombytes_buf(NONCE_BYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    conversationAd(label, ctx),
    null,
    n,
    key,
  );
  const blob = new Uint8Array(1 + n.length + ct.length);
  blob[0] = FORMAT_VERSION;
  blob.set(n, 1);
  blob.set(ct, 1 + n.length);
  return blob;
}

async function open(
  label: ConversationLabel,
  key: Uint8Array,
  ctx: ConversationRecordContext,
  blob: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  if (blob.length < 1 + NONCE_BYTES + 16) throw new Error('blob too short');
  if (blob[0] !== FORMAT_VERSION) throw new Error('unknown format version');
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    blob.subarray(1 + NONCE_BYTES),
    conversationAd(label, ctx),
    blob.subarray(1, 1 + NONCE_BYTES),
    key,
  );
}

/** The header is bound to the conversation: callers pass `recordId = conversationId`. */
export const sealHeader = (
  key: Uint8Array,
  ctx: ConversationRecordContext,
  plaintext: Uint8Array,
  nonce?: Uint8Array,
) => seal('conversation-header', key, ctx, plaintext, nonce);
export const openHeader = (
  key: Uint8Array,
  ctx: ConversationRecordContext,
  blob: Uint8Array,
) => open('conversation-header', key, ctx, blob);

export const sealMessage = (
  key: Uint8Array,
  ctx: ConversationRecordContext,
  plaintext: Uint8Array,
  nonce?: Uint8Array,
) => seal('conversation-message', key, ctx, plaintext, nonce);
export const openMessage = (
  key: Uint8Array,
  ctx: ConversationRecordContext,
  blob: Uint8Array,
) => open('conversation-message', key, ctx, blob);

export const sealAttachment = (
  key: Uint8Array,
  ctx: ConversationRecordContext,
  plaintext: Uint8Array,
  nonce?: Uint8Array,
) => seal('conversation-attachment', key, ctx, plaintext, nonce);
export const openAttachment = (
  key: Uint8Array,
  ctx: ConversationRecordContext,
  blob: Uint8Array,
) => open('conversation-attachment', key, ctx, blob);
