import { DomainValidationError } from '../../shared/domain/errors.js';
import { ENCRYPTED_BLOB_OVERHEAD_BYTES } from './conversation-limits.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Encrypted blob (header or message, docs/crypto/conversations.md): `0x01 ‖ nonce ‖ XChaCha20-Poly1305`, strict
 * base64url without padding. Returns its size in bytes. The backend only checks the shape; it cannot open it.
 * Bigger than `maxBytes` throws `tooLarge()` (checked on the text length first, before decoding).
 */
export function assertEncryptedBlob(
  s: string,
  maxBytes: number,
  tooLarge: () => Error,
): number {
  if (typeof s !== 'string' || !BASE64URL.test(s)) throw blobInvalid();
  if (Math.floor((s.length * 3) / 4) > maxBytes) throw tooLarge();
  const bytes = Buffer.from(s, 'base64url');
  if (
    bytes.toString('base64url') !== s ||
    bytes.length < ENCRYPTED_BLOB_OVERHEAD_BYTES ||
    bytes[0] !== 0x01
  ) {
    throw blobInvalid();
  }
  return bytes.length;
}

function blobInvalid(): DomainValidationError {
  return new DomainValidationError(
    'encrypted-blob-invalid',
    'The encrypted content is not in the expected format.',
  );
}
