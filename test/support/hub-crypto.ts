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
