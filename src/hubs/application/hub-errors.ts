import {
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';

/** Hub missing, deregistered or invisible to the caller: never reveals that it exists (404). */
export function hubNotFound(): NotFoundError {
  return new NotFoundError('hub-not-found', 'The hub was not found.');
}

/** A visible hub, an action the caller may not take (403). */
export function hubPermissionDenied(): PermissionDeniedError {
  return new PermissionDeniedError(
    'permission-denied',
    'You do not have permission to perform this action.',
  );
}

/** No live link or request between the hub and the organization (404). */
export function hubLinkNotFound(): NotFoundError {
  return new NotFoundError(
    'hub-link-not-found',
    'The hub has no link or request with this organization.',
  );
}

/** The space's organization has no approved link with the hub (422). */
export function organizationNotLinked(): DomainValidationError {
  return new DomainValidationError(
    'organization-not-linked',
    'The organization has no approved link with this hub.',
  );
}

/** Opening a space in the Room needs the space on the hub first (422). */
export function spaceNotOnHub(): DomainValidationError {
  return new DomainValidationError(
    'space-not-on-hub',
    'The space is not on this hub.',
  );
}

/** Removing a space that is not on the hub (404). */
export function hubSpaceNotFound(): NotFoundError {
  return new NotFoundError(
    'hub-space-not-found',
    'The space is not on this hub.',
  );
}

/** The Room of the hub does not hold the space (404). */
export function roomNotFound(): NotFoundError {
  return new NotFoundError(
    'room-not-found',
    'The space is not open in the room of this hub.',
  );
}

/** Hub roles go only to active members of an organization with an approved link (422). */
export function hubRoleTargetNotEligible(): DomainValidationError {
  return new DomainValidationError(
    'user-not-in-linked-organization',
    'The user is not an active member of any organization linked to this hub.',
  );
}
