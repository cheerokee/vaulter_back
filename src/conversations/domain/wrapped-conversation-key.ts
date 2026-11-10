import { DomainValidationError } from '../../shared/domain/errors.js';

/** Sealed copy of a conversation key version, base64url: 81 bytes = 108 chars. */
export const WRAPPED_CONVERSATION_KEY_PATTERN = /^[A-Za-z0-9_-]{108}$/;

/**
 * Sealed copy of one conversation key version (v1): `0x01 ‖ crypto_box_seal(key32, recipientPublicKey)`, the same
 * format as the space key copies (docs/crypto/conversations.md). The backend only checks the format.
 */
export function assertWrappedConversationKey(s: string): string {
  if (
    typeof s !== 'string' ||
    !WRAPPED_CONVERSATION_KEY_PATTERN.test(s) ||
    Buffer.from(s, 'base64url')[0] !== 0x01
  ) {
    throw new DomainValidationError(
      'wrapped-key-invalid',
      'The wrapped conversation key is invalid.',
    );
  }
  return s;
}
