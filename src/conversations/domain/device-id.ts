import { DomainValidationError } from '../../shared/domain/errors.js';
import { isUuidV7 } from '../../shared/domain/id.js';

/** Ids generated on the device (conversation, message, attachment) are UUID v7: they go into the encryption AD. */
export function assertDeviceId(id: string, code: string): string {
  if (typeof id !== 'string' || !isUuidV7(id)) {
    throw new DomainValidationError(code, 'The id must be a UUID v7.');
  }
  return id;
}

export function assertKeyVersion(v: number): number {
  if (!Number.isSafeInteger(v) || v < 1) {
    throw new DomainValidationError(
      'key-version-invalid',
      'The key version must be a whole number >= 1.',
    );
  }
  return v;
}
