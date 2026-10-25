import { DomainValidationError } from '../../shared/domain/errors.js';

/** trim -> NFC -> lowercase. Same rule as the identity module (copied: no cross-module domain imports). */
export function normalizeEmail(raw: string): string {
  return typeof raw === 'string'
    ? raw.trim().normalize('NFC').toLowerCase()
    : '';
}

export function assertInvitationEmail(raw: string): string {
  const email = normalizeEmail(raw);
  if (email.length < 1 || email.length > 255) {
    throw new DomainValidationError('email-invalid', 'The e-mail is invalid.');
  }
  return email;
}
