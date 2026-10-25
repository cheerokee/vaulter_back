import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { SodiumInvitationTokenCodec } from './sodium-invitation-token-codec.js';

const codec = new SodiumInvitationTokenCodec();

describe('SodiumInvitationTokenCodec', () => {
  it('generates a 32-byte base64url token (no padding) and its 64-hex hash', () => {
    const { token, tokenHash } = codec.generate();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(codec.hash(token)).toBe(tokenHash);
  });

  it('is random', () => {
    expect(codec.generate().token).not.toBe(codec.generate().token);
  });

  it('hashes the decoded bytes (not the text) with crypto_generichash(32)', async () => {
    const sodium = await getSodium();
    const bytes = Buffer.alloc(32, 5);
    expect(codec.hash(bytes.toString('base64url'))).toBe(
      sodium.to_hex(sodium.crypto_generichash(32, bytes, null)),
    );
  });

  it.each([
    ['empty', ''],
    ['short', 'abc'],
    ['bad charset', '+'.repeat(43)],
    ['padding', Buffer.alloc(32, 1).toString('base64')],
    ['too long', 'A'.repeat(44)],
    ['non-canonical last char', 'A'.repeat(42) + 'B'],
    ['not a string', 42 as unknown as string],
  ])('%s -> null', (_l, token) => {
    expect(codec.hash(token)).toBeNull();
  });
});
