import { DomainValidationError } from '../../shared/domain/errors.js';

const WRAPPED_KEY_BYTES = 81; // 1 version + 48 crypto_box_seal overhead + 32 space key

/**
 * Wrapped space key (v1): `0x01 || crypto_box_seal(spaceKey, recipientPublicKey)`, 81 bytes, strict base64url
 * without padding. The backend only checks format; it cannot tell whether the copy opens.
 */
export function assertWrappedSpaceKey(s: string): string {
  const bytes =
    typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s)
      ? Buffer.from(s, 'base64url')
      : null;
  if (
    !bytes ||
    bytes.length !== WRAPPED_KEY_BYTES ||
    bytes[0] !== 0x01 ||
    bytes.toString('base64url') !== s
  ) {
    throw new DomainValidationError(
      'wrapped-key-invalid',
      'The wrapped space key is invalid.',
    );
  }
  return s;
}
