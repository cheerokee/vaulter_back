import { performance } from 'node:perf_hooks';
import { LoadSheddingException } from '../../../shared/infra/http/load-shedding.exception.js';
import sodium from 'libsodium-wrappers-sumo';
import { MEM_LIMIT, OPS_LIMIT } from './argon2.worker.js';
import { SodiumAuthProofHasher } from './sodium-auth-proof-hasher.js';

describe('SodiumAuthProofHasher', () => {
  const hasher = new SodiumAuthProofHasher();
  const proof = 'q'.repeat(43);

  beforeAll(async () => {
    await hasher.onModuleInit();
  });

  afterAll(async () => {
    await hasher.onApplicationShutdown();
  });

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
    await fresh.onApplicationShutdown();
  });

  it('throws a clear error after shutdown instead of recreating a pool', async () => {
    const h = new SodiumAuthProofHasher();
    await h.onModuleInit();
    await h.onApplicationShutdown();
    await expect(h.hash(proof)).rejects.toThrow(/destroyed/);
    await expect(h.verify('x', proof)).rejects.toThrow(/destroyed/);
    await expect(h.verifyAgainstDummy(proof)).rejects.toThrow(/destroyed/);
  });

  it('does not cache a failed dummy hash forever', async () => {
    const h = new SodiumAuthProofHasher();
    const spy = vi
      .spyOn(h, 'hash')
      .mockRejectedValueOnce(new Error('transient'));
    await expect(h.verifyAgainstDummy(proof)).rejects.toThrow('transient');
    spy.mockRestore();
    expect(await h.verifyAgainstDummy(proof)).toBe(false);
    await h.onApplicationShutdown();
  });

  it('keeps the event loop free during parallel verifications', async () => {
    const hash = await hasher.hash(proof);
    await hasher.verify(hash, proof); // warm every worker path
    let last = performance.now();
    let maxLag = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
    }, 10);
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => hasher.verify(hash, proof)),
      );
      expect(results.every(Boolean)).toBe(true);
    } finally {
      maxLag = Math.max(maxLag, performance.now() - last - 10);
      clearInterval(timer);
    }
    expect(maxLag).toBeLessThan(50);
  });

  it('verifies a hash produced by libsodium on the main thread', async () => {
    await sodium.ready;
    const legacy = sodium.crypto_pwhash_str(proof, 2, 19_922_944);
    expect(await hasher.verify(legacy, proof)).toBe(true);
    expect(await hasher.verify(legacy, 'r'.repeat(43))).toBe(false);
  });

  it('uses the same Argon2id parameters as the documented ones', () => {
    expect(OPS_LIMIT).toBe(2);
    expect(MEM_LIMIT).toBe(19_922_944);
  });

  it('rejects with 503 when the queue is full instead of growing without bound', async () => {
    const h = new SodiumAuthProofHasher({
      get: (k: string) => ({ ARGON2_POOL_SIZE: 1, ARGON2_MAX_QUEUE: 1 })[k],
    } as never);
    await h.onModuleInit();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => h.hash(proof)),
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(LoadSheddingException);
    }
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    await h.onApplicationShutdown();
  });

  it('keeps the pool alive until application shutdown', async () => {
    const h = new SodiumAuthProofHasher();
    await h.onModuleInit();
    expect(await h.hash(proof)).toMatch(/^\$argon2id\$/);
    await h.onApplicationShutdown();
    await expect(h.hash(proof)).rejects.toThrow(/destroyed/);
  });
});
