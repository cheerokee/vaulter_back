import { DomainValidationError } from '../../shared/domain/errors.js';

/**
 * Recovery public key: raw X25519, 32 bytes, strict base64url without padding (canonical encoding).
 * Same rule as the user's public key; copied here because a domain never imports another module's domain.
 */
export function assertRecoveryPublicKey(s: string): string {
  const bytes =
    typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s)
      ? Buffer.from(s, 'base64url')
      : null;
  if (!bytes || bytes.length !== 32 || bytes.toString('base64url') !== s) {
    throw new DomainValidationError(
      'recovery-public-key-invalid',
      'The recovery public key is invalid.',
    );
  }
  return s;
}
