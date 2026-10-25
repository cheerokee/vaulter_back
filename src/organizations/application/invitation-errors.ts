import { DomainValidationError } from '../../shared/domain/errors.js';

/** The single stable error for any invitation that is not valid (unknown, expired, revoked, used, wrong e-mail). */
export function invitationInvalid(): DomainValidationError {
  return new DomainValidationError(
    'invitation-invalid',
    'The invitation is not valid.',
  );
}
