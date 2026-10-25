import { SodiumAuthProofHasher } from './sodium-auth-proof-hasher.js';

describe('SodiumAuthProofHasher', () => {
  const hasher = new SodiumAuthProofHasher();
  const proof = 'q'.repeat(43);

  it('verifies the right proof and rejects a wrong one', async () => {
    const hash = await hasher.hash(proof);
    expect(await hasher.verify(hash, proof)).toBe(true);
    expect(await hasher.verify(hash, 'r'.repeat(43))).toBe(false);
  });

  it('produces an argon2id string that fits VARCHAR(255)', async () => {
    const hash = await hasher.hash(proof);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash.length).toBeLessThanOrEqual(255);
  });

  it('returns false (not throws) for a malformed stored hash', async () => {
    expect(await hasher.verify('garbage', proof)).toBe(false);
    expect(await hasher.verify('', proof)).toBe(false);
  });

  it('verifyAgainstDummy is always false', async () => {
    expect(await hasher.verifyAgainstDummy(proof)).toBe(false);
    expect(await hasher.verifyAgainstDummy(proof)).toBe(false);
  });

  it('onModuleInit warms the dummy hash', async () => {
    const fresh = new SodiumAuthProofHasher();
    const spy = vi.spyOn(fresh, 'hash');
    await fresh.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(1);
    await fresh.verifyAgainstDummy(proof);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
