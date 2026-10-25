import { getSodium } from '../../src/shared/infra/crypto/sodium.js';
import {
  createClientAccount,
  deriveAuthProof,
  openPrivateKey,
  rewrapPrivateKey,
} from './client-crypto.js';

const decode = async (value: string): Promise<Uint8Array> => {
  const sodium = await getSodium();
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
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
});
