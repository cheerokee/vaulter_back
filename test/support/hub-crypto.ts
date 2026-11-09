import { getSodium } from '../../src/shared/infra/crypto/sodium.js';
import { sealSpaceKey } from './client-crypto.js';
import {
  HUB_LABELS,
  hubSignedBytes,
  type HubSignedFields,
} from '../../src/hubs/domain/hub-signed-message.js';

/** Client-side simulation of the Hub identity. See docs/crypto/hub-identity.md. */
export type HubIdentity = {
  signingPublicKey: string;
  signingPrivateKey: Uint8Array;
  encryptionPublicKey: string;
  encryptionPrivateKey: Uint8Array;
};

async function b64(bytes: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/** Random identity, or a deterministic one when `seed` (32 bytes) is given. */
export async function createHubIdentity(
  seed?: Uint8Array,
): Promise<HubIdentity> {
  const sodium = await getSodium();
  const sign = seed
    ? sodium.crypto_sign_seed_keypair(seed)
    : sodium.crypto_sign_keypair();
  const box = seed
    ? sodium.crypto_box_seed_keypair(seed)
    : sodium.crypto_box_keypair();
  return {
    signingPublicKey: await b64(sign.publicKey),
    signingPrivateKey: sign.privateKey,
    encryptionPublicKey: await b64(box.publicKey),
    encryptionPrivateKey: box.privateKey,
  };
}

export async function signHubMessage(
  identity: HubIdentity,
  label: string,
  fields: HubSignedFields,
): Promise<string> {
  const sodium = await getSodium();
  return b64(
    sodium.crypto_sign_detached(
      hubSignedBytes(label, fields),
      identity.signingPrivateKey,
    ),
  );
}

export function signEnrollment(
  identity: HubIdentity,
  fields: { nonce: string; timestamp: string },
): Promise<string> {
  return signHubMessage(identity, HUB_LABELS.enroll, {
    signingPublicKey: identity.signingPublicKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    ...fields,
  });
}

export function signStatus(
  identity: HubIdentity,
  fields: { enrollmentId: string; timestamp: string },
): Promise<string> {
  return signHubMessage(identity, HUB_LABELS.status, fields);
}

export function signAuth(
  identity: HubIdentity,
  fields: { hubId: string; challenge: string },
): Promise<string> {
  return signHubMessage(identity, HUB_LABELS.auth, fields);
}

/**
 * What the owner's app sends to open a space in the Room: every key version (keys[i] = version i + 1) sealed for the
 * hub's encryption public key.
 */
export function sealRoomGrants(
  keys: Uint8Array[],
  hubEncryptionPublicKey: string,
): Promise<{ version: number; wrappedKey: string }[]> {
  return Promise.all(
    keys.map(async (key, i) => ({
      version: i + 1,
      wrappedKey: await sealSpaceKey(key, hubEncryptionPublicKey),
    })),
  );
}

/** Space backup object format. See docs/crypto/space-backup.md. */
export type BackupObjectContext = {
  spaceId: string;
  objectId: string;
  keyVersion: number;
};

const BACKUP_FORMAT_VERSION = 1;
const BACKUP_NONCE_BYTES = 24;

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll('-', '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error('invalid uuid');
  return Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
}

function backupAd(ctx: BackupObjectContext): Uint8Array {
  const prefix = new TextEncoder().encode('space-object');
  const ad = new Uint8Array(1 + prefix.length + 16 + 16 + 4);
  ad[0] = BACKUP_FORMAT_VERSION;
  ad.set(prefix, 1);
  ad.set(uuidBytes(ctx.spaceId), 1 + prefix.length);
  ad.set(uuidBytes(ctx.objectId), 1 + prefix.length + 16);
  new DataView(ad.buffer).setUint32(1 + prefix.length + 32, ctx.keyVersion);
  return ad;
}

/** `0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(plaintext, ad)`; random nonce unless given. */
export async function sealBackupObject(
  spaceKey: Uint8Array,
  ctx: BackupObjectContext,
  plaintext: Uint8Array,
  nonce?: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const n = nonce ?? sodium.randombytes_buf(BACKUP_NONCE_BYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    backupAd(ctx),
    null,
    n,
    spaceKey,
  );
  const blob = new Uint8Array(1 + n.length + ct.length);
  blob[0] = BACKUP_FORMAT_VERSION;
  blob.set(n, 1);
  blob.set(ct, 1 + n.length);
  return blob;
}

/** Throws when the version byte, the key, the context or the bytes do not match. */
export async function openBackupObject(
  spaceKey: Uint8Array,
  ctx: BackupObjectContext,
  blob: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  if (blob.length < 1 + BACKUP_NONCE_BYTES + 16)
    throw new Error('backup object too short');
  if (blob[0] !== BACKUP_FORMAT_VERSION)
    throw new Error('unknown backup object version');
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    blob.subarray(1 + BACKUP_NONCE_BYTES),
    backupAd(ctx),
    blob.subarray(1, 1 + BACKUP_NONCE_BYTES),
    spaceKey,
  );
}

/** Lowercase hex SHA-256 of the whole blob (what the backend stores and compares). */
export async function sha256Hex(blob: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_hex(sodium.crypto_hash_sha256(blob));
}
