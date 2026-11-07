import type { ConfigService } from '@nestjs/config';
import { SodiumRecoveryProofHasher } from './sodium-recovery-proof-hasher.js';

const config = (key: string) =>
  ({ getOrThrow: () => key }) as unknown as ConfigService;
const KEY_A = 'A'.repeat(43);
const KEY_B = 'B'.repeat(42) + 'A';
const PROOF = Buffer.alloc(32, 0x11).toString('base64url');
const OTHER = Buffer.alloc(32, 0x22).toString('base64url');

function hasher(key = KEY_A) {
  const h = new SodiumRecoveryProofHasher(config(key));
  h.onModuleInit();
  return h;
}

describe('SodiumRecoveryProofHasher', () => {
  it('verifies the proof it hashed and rejects another one', () => {
    const h = hasher();
    const hash = h.hash(PROOF);
    expect(h.verify(hash, PROOF)).toBe(true);
    expect(h.verify(hash, OTHER)).toBe(false);
  });

  it('hashes to 64 hex chars, deterministically, depending on the key', () => {
    const h = hasher();
    const hash = h.hash(PROOF);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.hash(PROOF)).toBe(hash);
    expect(hasher(KEY_B).hash(PROOF)).not.toBe(hash);
    expect(hasher(KEY_B).verify(hash, PROOF)).toBe(false);
  });

  it('uses the account-recovery-proof-v1 domain separation', async () => {
    const { getSodium } =
      await import('../../../shared/infra/crypto/sodium.js');
    const sodium = await getSodium();
    const key = Buffer.from(KEY_A, 'base64url');
    const expected = sodium.to_hex(
      sodium.crypto_generichash(
        32,
        Buffer.from('account-recovery-proof-v1\0' + PROOF, 'utf8'),
        key,
      ),
    );
    expect(hasher().hash(PROOF)).toBe(expected);
  });

  it('rejects a malformed stored hash without throwing', () => {
    const h = hasher();
    expect(h.verify('', PROOF)).toBe(false);
    expect(h.verify('zz'.repeat(32), PROOF)).toBe(false);
    expect(h.verify(h.hash(PROOF).slice(0, 62), PROOF)).toBe(false);
  });

  it('verifyAgainstDummy does the work without throwing', () => {
    expect(() => hasher().verifyAgainstDummy(PROOF)).not.toThrow();
  });

  it('fails fast at boot when the key is missing', () => {
    const h = new SodiumRecoveryProofHasher({
      getOrThrow: () => {
        throw new Error('missing');
      },
    } as unknown as ConfigService);
    expect(() => h.onModuleInit()).toThrow('missing');
  });
});
