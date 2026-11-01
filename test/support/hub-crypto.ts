import { getSodium } from '../../src/shared/infra/crypto/sodium.js';
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
