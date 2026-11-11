import { DomainValidationError } from '../../shared/domain/errors.js';

/** Version byte of a sealed key copy (`docs/crypto/user-keys.md`, the locked copy). */
export const SEALED_COPY_VERSION = 0x01;
/** 1 version + 48 `crypto_box_seal` overhead + 32 key = 81 bytes, 108 base64url chars. */
export const SEALED_COPY_BYTES = 81;
export const SEALED_KEY_BYTES = 32;

/**
 * A sealed copy of a 32-byte key (space key or conversation key) for an X25519 recipient (here, the server):
 * `0x01 ‖ crypto_box_seal(key, recipientPublicKey)`, strict base64url without padding. Returns the sealed box
 * (without the version byte). The format check is the same the spaces/conversations modules apply to Hub copies;
 * only the server can tell whether a copy sealed to it actually opens.
 */
export function parseSealedCopy(copy: string): Uint8Array {
  const bytes =
    typeof copy === 'string' && /^[A-Za-z0-9_-]{108}$/.test(copy)
      ? Buffer.from(copy, 'base64url')
      : null;
  if (
    !bytes ||
    bytes.length !== SEALED_COPY_BYTES ||
    bytes[0] !== SEALED_COPY_VERSION ||
    bytes.toString('base64url') !== copy
  ) {
    throw sealedCopyInvalid();
  }
  return new Uint8Array(bytes.subarray(1));
}

/** Same error for a malformed copy and for one that does not open with the server key (no oracle on which). */
export function sealedCopyInvalid(): DomainValidationError {
  return new DomainValidationError(
    'server-copy-invalid',
    'The key copy for the server is invalid.',
  );
}
