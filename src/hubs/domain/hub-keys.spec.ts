import {
  assertEncryptionPublicKey,
  assertEnrollmentNonce,
  assertSigningPublicKey,
} from './hub-keys.js';

const valid = Buffer.alloc(32, 7).toString('base64url');

describe('hub keys', () => {
  it.each([assertSigningPublicKey, assertEncryptionPublicKey])(
    'accepts 32 bytes base64url and rejects the rest',
    (assertKey) => {
      expect(assertKey(valid)).toBe(valid);
      for (const bad of [
        '',
        valid + '=',
        valid.slice(1),
        '+' + valid.slice(1),
        'A'.repeat(42) + 'B',
        Buffer.alloc(33).toString('base64url'),
        42 as unknown as string,
      ]) {
        expect(() => assertKey(bad)).toThrow();
      }
    },
  );
});

describe('assertEnrollmentNonce', () => {
  it('accepts 16 bytes of strict base64url and rejects the rest', () => {
    const nonce = Buffer.alloc(16, 3).toString('base64url');
    expect(assertEnrollmentNonce(nonce)).toBe(nonce);
    const nonCanonical = nonce.slice(0, 21) + 'B';
    for (const bad of [
      '',
      'n',
      Buffer.alloc(15, 3).toString('base64url'),
      Buffer.alloc(17, 3).toString('base64url'),
      nonce + '=',
      nonCanonical,
      42 as unknown as string,
    ]) {
      expect(() => assertEnrollmentNonce(bad)).toThrow(
        expect.objectContaining({ code: 'nonce-invalid' }),
      );
    }
  });
});
