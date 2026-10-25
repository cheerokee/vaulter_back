import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { SodiumKeyFingerprinter } from './sodium-key-fingerprinter.js';

const fp = new SodiumKeyFingerprinter();
const key = (n: number) => Buffer.alloc(32, n).toString('base64url');

describe('SodiumKeyFingerprinter', () => {
  it('is deterministic, 64 hex chars and changes with the key', async () => {
    const a = await fp.fingerprint(key(1));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await fp.fingerprint(key(1))).toBe(a);
    expect(await fp.fingerprint(key(2))).not.toBe(a);
  });

  it('is hex of crypto_generichash(32) over the decoded bytes', async () => {
    const sodium = await getSodium();
    expect(await fp.fingerprint(key(9))).toBe(
      sodium.to_hex(sodium.crypto_generichash(32, Buffer.alloc(32, 9), null)),
    );
  });

  it('rejects a key that is not 32 bytes', async () => {
    await expect(
      fp.fingerprint(Buffer.alloc(31, 1).toString('base64url')),
    ).rejects.toThrow(/32 bytes/);
    await expect(fp.fingerprint('')).rejects.toThrow(/32 bytes/);
  });

  it('matches the documented vector (docs/crypto/user-keys.md)', async () => {
    expect(
      await fp.fingerprint('Z13VdO13iTELPS52gfN5C0ZsdzsVIf7PNld5WDcepS8'),
    ).toBe('213651d4214dfd9437ca03e59a0ea03f8f53a1f6aae410a239df9f1096f703c4');
  });
});
