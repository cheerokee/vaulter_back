import { getSodium } from '../../src/shared/infra/crypto/sodium.js';
import { openBackupObject, sealBackupObject, sha256Hex } from './hub-crypto.js';

// Vector from docs/crypto/space-backup.md.
const seq = (start: number, n: number) =>
  Uint8Array.from({ length: n }, (_, i) => start + i);
const KEY = seq(0x00, 32);
const NONCE = seq(0x20, 24);
const CTX = {
  spaceId: '40414243-4445-4647-4849-4a4b4c4d4e4f',
  objectId: '50515253-5455-5657-5859-5a5b5c5d5e5f',
  keyVersion: 1,
};
const BLOB_HEX =
  '01202122232425262728292a2b2c2d2e2f3031323334353637753c21a714be59b571e563b16d585f9197231329b2';
const SHA_HEX =
  'b51e337a6468c8af4e936615c6b05b9fe001bb9d0cf8ab1c99e0ab4c47d48b25';
const plain = new TextEncoder().encode('hello');

describe('space backup object format', () => {
  it('matches the documented test vector', async () => {
    const sodium = await getSodium();
    const blob = await sealBackupObject(KEY, CTX, plain, NONCE);
    expect(sodium.to_hex(blob)).toBe(BLOB_HEX);
    expect(await sha256Hex(blob)).toBe(SHA_HEX);
  });

  it('opens what it sealed', async () => {
    const blob = await sealBackupObject(KEY, CTX, plain);
    expect(await openBackupObject(KEY, CTX, blob)).toEqual(plain);
  });

  it.each([
    ['objectId', { objectId: '50515253-5455-5657-5859-5a5b5c5d5e60' }],
    ['spaceId', { spaceId: '40414243-4445-4647-4849-4a4b4c4d4e50' }],
    ['keyVersion', { keyVersion: 2 }],
  ])('refuses to open with another %s', async (_name, change) => {
    const blob = await sealBackupObject(KEY, CTX, plain, NONCE);
    await expect(
      openBackupObject(KEY, { ...CTX, ...change }, blob),
    ).rejects.toThrow();
  });

  it('refuses an unknown format version', async () => {
    const blob = await sealBackupObject(KEY, CTX, plain, NONCE);
    blob[0] = 2;
    await expect(openBackupObject(KEY, CTX, blob)).rejects.toThrow();
  });
});
