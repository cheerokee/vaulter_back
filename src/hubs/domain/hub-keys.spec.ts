import {
  assertEncryptionPublicKey,
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
