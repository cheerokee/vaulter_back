import { DomainValidationError } from '../../shared/domain/errors.js';

// Strict base64url without padding: canonical encoding and exact decoded length.
function check(value: unknown, code: string, message: string): string {
  if (typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)) {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length === 32 && bytes.toString('base64url') === value) {
      return value;
    }
  }
  throw new DomainValidationError(code, message);
}

export function assertSigningPublicKey(value: string): string {
  return check(
    value,
    'signing-public-key-invalid',
    'The signing public key is invalid.',
  );
}

export function assertEncryptionPublicKey(value: string): string {
  return check(
    value,
    'encryption-public-key-invalid',
    'The encryption public key is invalid.',
  );
}
