import { UnauthenticatedError } from '../../shared/domain/errors.js';

/**
 * The single 401 of `POST /hub-auth/token`: unknown or deregistered hub, bad signature, unknown, used, expired or
 * decoy challenge all look the same.
 */
export function hubAuthFailed(): UnauthenticatedError {
  return new UnauthenticatedError(
    'hub-auth-failed',
    'The hub could not be authenticated.',
  );
}

/** The single 401 of the hub token guard (bad token, user token, unknown or deregistered hub). */
export function invalidHubToken(): UnauthenticatedError {
  return new UnauthenticatedError(
    'invalid-hub-token',
    'The hub token is missing, invalid or expired.',
  );
}
