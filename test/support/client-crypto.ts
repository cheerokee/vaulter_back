import { getSodium } from '../../src/shared/infra/crypto/sodium.js';

/** Client-side simulation of the v1 user key material. See docs/crypto/user-keys.md. */
export type KdfParams = {
  algorithm: 'argon2id13';
  opsLimit: number;
  memLimitBytes: number;
};

export type ClientAccount = {
  kdfSalt: string;
  kdfParams: KdfParams;
  authProof: string;
  publicKey: string;
  encryptedPrivateKey: string;
  privateKey: Uint8Array;
};

export const TEST_KDF_PARAMS: KdfParams = {
  algorithm: 'argon2id13',
  opsLimit: 2,
  memLimitBytes: 67108864,
};

const CONTEXT = 'acctkeys';
const FORMAT_VERSION = 1;

async function b64(bytes: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

async function fromB64(value: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

async function masterKey(
  password: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.crypto_pwhash(
    32,
    password.normalize('NFC'),
    salt,
    params.opsLimit,
    params.memLimitBytes,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** Both subkeys from the master key. The encryption key never leaves the device. */
export async function deriveKeys(
  password: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<{ authProof: Uint8Array; encKey: Uint8Array }> {
  const sodium = await getSodium();
  const master = await masterKey(password, salt, params);
  return {
    authProof: sodium.crypto_kdf_derive_from_key(32, 1, CONTEXT, master),
    encKey: sodium.crypto_kdf_derive_from_key(32, 2, CONTEXT, master),
  };
}

/** 0x01 || nonce(24) || AEAD(privateKey, ad = 0x01) -> 73 bytes. */
export async function sealPrivateKey(
  privateKey: Uint8Array,
  encKey: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const version = new Uint8Array([FORMAT_VERSION]);
  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    privateKey,
    version,
    null,
    nonce,
    encKey,
  );
  const blob = new Uint8Array(1 + nonce.length + cipher.length);
  blob.set(version, 0);
  blob.set(nonce, 1);
  blob.set(cipher, 1 + nonce.length);
  return blob;
}

async function wrap(
  privateKey: Uint8Array,
  password: string,
  salt: Uint8Array,
  params: KdfParams,
) {
  const sodium = await getSodium();
  const { authProof, encKey } = await deriveKeys(password, salt, params);
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
  );
  const blob = await sealPrivateKey(privateKey, encKey, nonce);
  return {
    kdfSalt: await b64(salt),
    kdfParams: params,
    authProof: await b64(authProof),
    encryptedPrivateKey: await b64(blob),
  };
}

export async function createClientAccount(
  password: string,
  kdfParams: KdfParams = TEST_KDF_PARAMS,
): Promise<ClientAccount> {
  const sodium = await getSodium();
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const keypair = sodium.crypto_box_keypair();
  const wrapped = await wrap(keypair.privateKey, password, salt, kdfParams);
  return {
    ...wrapped,
    publicKey: await b64(keypair.publicKey),
    privateKey: keypair.privateKey,
  };
}

export async function deriveAuthProof(
  password: string,
  kdfSalt: string,
  kdfParams: KdfParams,
): Promise<string> {
  const { authProof } = await deriveKeys(
    password,
    await fromB64(kdfSalt),
    kdfParams,
  );
  return b64(authProof);
}

/** Throws when the password is wrong or the blob is malformed. */
export async function openPrivateKey(
  password: string,
  kdfSalt: string,
  kdfParams: KdfParams,
  encryptedPrivateKey: string,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const blob = await fromB64(encryptedPrivateKey);
  if (blob[0] !== FORMAT_VERSION) {
    throw new Error('unsupported key format version');
  }
  const nonceLength = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const { encKey } = await deriveKeys(
    password,
    await fromB64(kdfSalt),
    kdfParams,
  );
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    blob.slice(1 + nonceLength),
    blob.slice(0, 1),
    blob.slice(1, 1 + nonceLength),
    encKey,
  );
}

/** Password change: same private key, new salt, new proof, new wrapping. */
export async function rewrapPrivateKey(
  privateKey: Uint8Array,
  newPassword: string,
  kdfParams: KdfParams = TEST_KDF_PARAMS,
): Promise<{
  kdfSalt: string;
  kdfParams: KdfParams;
  authProof: string;
  encryptedPrivateKey: string;
}> {
  const sodium = await getSodium();
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  return wrap(privateKey, newPassword, salt, kdfParams);
}

const SPACE_KEY_VERSION = 1;

/** Space key: 32 random bytes. */
export async function generateSpaceKey(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.randombytes_buf(32);
}

/** 0x01 || crypto_box_seal(spaceKey, recipient X25519 public key) -> 81 bytes, base64url. */
export async function sealSpaceKey(
  spaceKey: Uint8Array,
  recipientPublicKeyB64u: string,
): Promise<string> {
  const sodium = await getSodium();
  const sealed = sodium.crypto_box_seal(
    spaceKey,
    await fromB64(recipientPublicKeyB64u),
  );
  const blob = new Uint8Array(1 + sealed.length);
  blob[0] = SPACE_KEY_VERSION;
  blob.set(sealed, 1);
  return b64(blob);
}

/** Throws when the version is unsupported or the pair does not open the copy. */
export async function openSpaceKey(
  wrappedB64u: string,
  publicKeyB64u: string,
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const blob = await fromB64(wrappedB64u);
  if (blob[0] !== SPACE_KEY_VERSION) {
    throw new Error('unsupported wrapped key format version');
  }
  return sodium.crypto_box_seal_open(
    blob.slice(1),
    await fromB64(publicKeyB64u),
    privateKey,
  );
}

/** Organization recovery kit keypair (X25519). */
export async function recoveryKitKeypair(): Promise<{
  publicKey: string;
  privateKey: Uint8Array;
}> {
  const sodium = await getSodium();
  const pair = sodium.crypto_box_keypair();
  return { publicKey: await b64(pair.publicKey), privateKey: pair.privateKey };
}
