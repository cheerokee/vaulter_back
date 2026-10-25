import { getSodium } from '../../src/shared/infra/crypto/sodium.js';
import {
  createClientAccount,
  deriveAuthProof,
  openPrivateKey,
  rewrapPrivateKey,
  deriveKeys,
  sealPrivateKey,
  generateSpaceKey,
  sealSpaceKey,
  openSpaceKey,
  recoveryKitKeypair,
  TEST_KDF_PARAMS,
} from './client-crypto.js';

const decode = async (value: string): Promise<Uint8Array> => {
  const sodium = await getSodium();
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
};

const encode = async (bytes: Uint8Array): Promise<string> => {
  const sodium = await getSodium();
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
};

const VECTOR = {
  password: 'p\u00e1ssw\u00f6rd-\u00e7\u00e3o',
  authProofHex:
    'fa19859a223eab1569716ecf6c992e08022e1885a40c7986426ce53366e25310',
  encKeyHex: '2fc44862c075b832b88eab5bb8eda4f644d761d6a8c4ed00774c5c35e1487a33',
  privateKeyHex:
    '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
  nonceHex: '404142434445464748494a4b4c4d4e4f5051525354555657',
  encryptedPrivateKey:
    'AUBBQkNERUZHSElKS0xNTk9QUVJTVFVWVyVmvEhw5hdU_i8_F5QXRdBzxrOQEYU4T5WNY0ytgSvemr3tpmGm9ofdjXdxwLdS-A',
};

describe('client-crypto', () => {
  it('round-trips the private key with the right password', async () => {
    const account = await createClientAccount('correct horse');
    const opened = await openPrivateKey(
      'correct horse',
      account.kdfSalt,
      account.kdfParams,
      account.encryptedPrivateKey,
    );
    expect(opened).toEqual(account.privateKey);
  }, 30_000);

  it('fails to open with a wrong password', async () => {
    const account = await createClientAccount('correct horse');
    await expect(
      openPrivateKey(
        'wrong',
        account.kdfSalt,
        account.kdfParams,
        account.encryptedPrivateKey,
      ),
    ).rejects.toThrow();
  }, 30_000);

  it('produces the v1 sizes', async () => {
    const account = await createClientAccount('pw');
    expect((await decode(account.publicKey)).length).toBe(32);
    const blob = await decode(account.encryptedPrivateKey);
    expect(blob.length).toBe(73);
    expect(blob[0]).toBe(1);
    expect((await decode(account.authProof)).length).toBe(32);
    expect((await decode(account.kdfSalt)).length).toBe(16);
    expect(account.privateKey.length).toBe(32);
  }, 30_000);

  it('authProof is deterministic for same password and salt and differs from the encryption key', async () => {
    const account = await createClientAccount('pw');
    const again = await deriveAuthProof(
      'pw',
      account.kdfSalt,
      account.kdfParams,
    );
    expect(again).toBe(account.authProof);
    const other = await deriveAuthProof(
      'pw2',
      account.kdfSalt,
      account.kdfParams,
    );
    expect(other).not.toBe(account.authProof);

    // The encryption key (subkey 2) must differ from the proof (subkey 1).
    const sodium = await getSodium();
    const master = sodium.crypto_pwhash(
      32,
      'pw',
      await decode(account.kdfSalt),
      account.kdfParams.opsLimit,
      account.kdfParams.memLimitBytes,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    const encKey = sodium.to_base64(
      sodium.crypto_kdf_derive_from_key(32, 2, 'acctkeys', master),
      sodium.base64_variants.URLSAFE_NO_PADDING,
    );
    expect(encKey).not.toBe(account.authProof);
  }, 30_000);

  it('rewrap keeps the same private key under the new password', async () => {
    const account = await createClientAccount('old');
    const rewrapped = await rewrapPrivateKey(account.privateKey, 'new');
    expect(rewrapped.kdfSalt).not.toBe(account.kdfSalt);
    expect(rewrapped.authProof).not.toBe(account.authProof);
    const opened = await openPrivateKey(
      'new',
      rewrapped.kdfSalt,
      rewrapped.kdfParams,
      rewrapped.encryptedPrivateKey,
    );
    expect(opened).toEqual(account.privateKey);
  }, 30_000);

  it('normalizes the password to NFC (NFD and NFC give the same authProof)', async () => {
    const account = await createClientAccount('\u00e7\u00e3\u00e9');
    const nfd = await deriveAuthProof(
      '\u00e7\u00e3\u00e9'.normalize('NFD'),
      account.kdfSalt,
      account.kdfParams,
    );
    expect(nfd).toBe(account.authProof);
  }, 30_000);

  it('rejects a tampered version byte', async () => {
    const account = await createClientAccount('pw');
    const blob = await decode(account.encryptedPrivateKey);
    blob[0] = 2;
    await expect(
      openPrivateKey(
        'pw',
        account.kdfSalt,
        account.kdfParams,
        await encode(blob),
      ),
    ).rejects.toThrow();
  }, 30_000);

  it('rejects a flipped ciphertext byte', async () => {
    const account = await createClientAccount('pw');
    const blob = await decode(account.encryptedPrivateKey);
    blob[30] ^= 1;
    await expect(
      openPrivateKey(
        'pw',
        account.kdfSalt,
        account.kdfParams,
        await encode(blob),
      ),
    ).rejects.toThrow();
  }, 30_000);

  it('matches the documented v1 test vector', async () => {
    const hex = async (v: Uint8Array) => (await getSodium()).to_hex(v);
    const sodium = await getSodium();
    const salt = sodium.from_hex('000102030405060708090a0b0c0d0e0f');
    const { authProof, encKey } = await deriveKeys(
      VECTOR.password,
      salt,
      TEST_KDF_PARAMS,
    );
    expect(await hex(authProof)).toBe(VECTOR.authProofHex);
    expect(await hex(encKey)).toBe(VECTOR.encKeyHex);
    const blob = await sealPrivateKey(
      sodium.from_hex(VECTOR.privateKeyHex),
      encKey,
      sodium.from_hex(VECTOR.nonceHex),
    );
    expect(await encode(blob)).toBe(VECTOR.encryptedPrivateKey);
  }, 30_000);
});

describe('space key helpers', () => {
  const b64 = async (v: Uint8Array) =>
    (await getSodium()).to_base64(
      v,
      (await getSodium()).base64_variants.URLSAFE_NO_PADDING,
    );

  it('generates 32 random bytes', async () => {
    const a = await generateSpaceKey();
    expect(a).toHaveLength(32);
    expect(await b64(a)).not.toBe(await b64(await generateSpaceKey()));
  });

  it('seals to 81 bytes with version 1 and opens with the right pair', async () => {
    const pair = await recoveryKitKeypair();
    const key = await generateSpaceKey();
    const wrapped = await sealSpaceKey(key, pair.publicKey);
    expect(wrapped).toMatch(/^[A-Za-z0-9_-]{108}$/);
    const raw = Buffer.from(wrapped, 'base64url');
    expect(raw).toHaveLength(81);
    expect(raw[0]).toBe(1);
    expect(
      await openSpaceKey(wrapped, pair.publicKey, pair.privateKey),
    ).toEqual(key);
  });

  it('does not open with the wrong pair', async () => {
    const pair = await recoveryKitKeypair();
    const other = await recoveryKitKeypair();
    const wrapped = await sealSpaceKey(
      await generateSpaceKey(),
      pair.publicKey,
    );
    await expect(
      openSpaceKey(wrapped, other.publicKey, other.privateKey),
    ).rejects.toThrow();
  });

  it('rejects an unsupported version when opening', async () => {
    const pair = await recoveryKitKeypair();
    const wrapped = await sealSpaceKey(
      await generateSpaceKey(),
      pair.publicKey,
    );
    const raw = Buffer.from(wrapped, 'base64url');
    raw[0] = 2;
    await expect(
      openSpaceKey(raw.toString('base64url'), pair.publicKey, pair.privateKey),
    ).rejects.toThrow('unsupported');
  });

  it('opens the documented v1 space key test vector', async () => {
    const sodium = await getSodium();
    const privateKey = sodium.from_hex(SPACE_VECTOR.privateKeyHex);
    const publicKey = await b64(sodium.crypto_scalarmult_base(privateKey));
    expect(publicKey).toBe(SPACE_VECTOR.publicKey);
    const opened = await openSpaceKey(
      SPACE_VECTOR.wrappedKey,
      publicKey,
      privateKey,
    );
    expect(sodium.to_hex(opened)).toBe(SPACE_VECTOR.spaceKeyHex);
  });
});

const SPACE_VECTOR = {
  privateKeyHex:
    '606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f',
  publicKey: 'Z13VdO13iTELPS52gfN5C0ZsdzsVIf7PNld5WDcepS8',
  spaceKeyHex:
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  wrappedKey:
    'AdwKH5FH2gGEG0G0xcaboGdZ8hzlNG7cZBdOFFlZj7sTux3htnYMie3AYgYtHttohH7FgzBVdy6pRWaiouIlD9NZRXGuuEuFP1THe9YvfTnX',
};
