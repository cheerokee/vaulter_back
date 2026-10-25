import { DomainValidationError } from '../../shared/domain/errors.js';
import { assertRecoveryPublicKey } from './recovery-public-key.js';

describe('assertRecoveryPublicKey', () => {
  it('accepts 32 bytes in canonical base64url', () => {
    const pk = Buffer.alloc(32, 7).toString('base64url');
    expect(assertRecoveryPublicKey(pk)).toBe(pk);
  });

  it('rejects other sizes, padding, non-canonical or non-string input', () => {
    const pk = Buffer.alloc(32, 7).toString('base64url');
    for (const bad of [
      Buffer.alloc(31).toString('base64url'),
      Buffer.alloc(33).toString('base64url'),
      `${pk}=`,
      Buffer.alloc(32, 7).toString('base64'),
      pk.slice(0, -1) + 'x',
      '',
      42 as unknown as string,
    ]) {
      expect(() => assertRecoveryPublicKey(bad)).toThrowError(
        DomainValidationError,
      );
    }
  });
});
