import { DomainValidationError } from '../../shared/domain/errors.js';

// Strict base64url without padding: canonical encoding and exact decoded length.
function decodeStrict(value: unknown, size: number): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value)
    return null;
  return bytes;
}

function check(
  value: string,
  size: number,
  code: string,
  message: string,
  extra?: (bytes: Buffer) => boolean,
): string {
  const bytes = decodeStrict(value, size);
  if (!bytes || (extra && !extra(bytes))) {
    throw new DomainValidationError(code, message);
  }
  return value;
}

export function assertKdfSalt(s: string): string {
  return check(s, 16, 'kdf-salt-invalid', 'The KDF salt is invalid.');
}

export function assertPublicKey(s: string): string {
  return check(s, 32, 'public-key-invalid', 'The public key is invalid.');
}

export function assertEncryptedPrivateKey(s: string): string {
  return check(
    s,
    73,
    'encrypted-private-key-invalid',
    'The encrypted private key is invalid.',
    (b) => b[0] === 0x01,
  );
}

export function assertAuthProof(s: string): string {
  return check(s, 32, 'auth-proof-invalid', 'The auth proof is invalid.');
}
