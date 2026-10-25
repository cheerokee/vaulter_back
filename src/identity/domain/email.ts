import { DomainValidationError } from '../../shared/domain/errors.js';

/** trim -> NFC -> lowercase. Lowercasing can grow the string, so length is checked afterwards. */
export function normalizeEmail(raw: string): string {
  return raw.trim().normalize('NFC').toLowerCase();
}

/** Validates the length of an already normalized e-mail (1..255, the column size). */
export function assertEmailLength(email: string): string {
  if (email.length < 1 || email.length > 255) {
    throw new DomainValidationError('email-invalid', 'The e-mail is invalid.');
  }
  return email;
}
