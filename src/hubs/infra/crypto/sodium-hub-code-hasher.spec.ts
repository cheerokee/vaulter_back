import type { ConfigService } from '@nestjs/config';
import { SodiumHubCodeHasher } from './sodium-hub-code-hasher.js';

const config = (key: string) =>
  ({ getOrThrow: () => key }) as unknown as ConfigService;
const KEY_A = 'A'.repeat(43);
const KEY_B = 'B'.repeat(42) + 'A';

function hasher(key = KEY_A) {
  const h = new SodiumHubCodeHasher(config(key));
  h.onModuleInit();
  return h;
}

describe('SodiumHubCodeHasher', () => {
  it('generates 8-digit codes, zero-padded, roughly uniform', () => {
    const h = hasher();
    const leading = Array.from({ length: 10 }, () => 0);
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const code = h.newCode();
      expect(code).toMatch(/^\d{8}$/);
      leading[Number(code[0])]!++;
    }
    for (const count of leading) {
      expect(count).toBeGreaterThan(n / 10 - 400);
      expect(count).toBeLessThan(n / 10 + 400);
    }
  });

  it('hashes the code deterministically, depending on HUB_CODE_HASH_KEY', async () => {
    const h = hasher();
    const hash = await h.hash('01234567');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await h.hash('01234567')).toBe(hash);
    expect(await h.hash('01234568')).not.toBe(hash);
    expect(await hasher(KEY_B).hash('01234567')).not.toBe(hash);
  });

  it('hashes a link code with its own domain separation (never equal to the claim-code hash)', async () => {
    const h = hasher();
    const hash = await h.hashLinkCode('01234567');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await h.hashLinkCode('01234567')).toBe(hash);
    expect(await h.hash('01234567')).not.toBe(hash);
    expect(await hasher(KEY_B).hashLinkCode('01234567')).not.toBe(hash);
  });

  it('generates 32-byte base64url challenges and hashes them with domain separation', async () => {
    const h = hasher();
    const c = h.newChallenge();
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(c, 'base64url')).toHaveLength(32);
    expect(h.newChallenge()).not.toBe(c);
    const hash = await h.hashChallenge(c);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await h.hashChallenge(c)).toBe(hash);
    expect(await h.hash(c)).not.toBe(hash);
    expect(await hasher(KEY_B).hashChallenge(c)).not.toBe(hash);
  });

  it('fails fast at boot when the key is missing', () => {
    const h = new SodiumHubCodeHasher({
      getOrThrow: () => {
        throw new Error('missing');
      },
    } as unknown as ConfigService);
    expect(() => h.onModuleInit()).toThrow('missing');
  });
});
