import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';

// Stable error codes of the module (plan, global constraints). One factory per code, so the code is never retyped.

/** Not a participant, nonexistent or of another organization: always the same 404. */
export const conversationNotFound = () =>
  new NotFoundError(
    'conversation-not-found',
    'The conversation was not found.',
  );

/** A participant without the power (owner only, or someone else's message). */
export const notConversationOwner = () =>
  new PermissionDeniedError(
    'not-conversation-owner',
    'Only the owner of the conversation (or the author, for a message) can do this.',
  );

export const conversationKeyRotationRequired = () =>
  new ConflictError(
    'conversation-key-rotation-required',
    'A participant left: rotate the conversation key before writing.',
  );

export const conversationKeyVersionStale = (expectedVersion: number) =>
  new ConflictError(
    'conversation-key-version-stale',
    'The conversation key version is not the expected one.',
    { expectedVersion },
  );

export const executorInvalid = () =>
  new DomainValidationError(
    'executor-invalid',
    'The executor must be a Hub whose owner participates in the conversation and that has the space installed.',
  );

export const participantNotSpaceMember = () =>
  new DomainValidationError(
    'participant-not-space-member',
    'Only members of the space can participate in the conversation.',
  );

export const conversationParticipantLimit = (limit: number) =>
  new ConflictError(
    'conversation-participant-limit',
    'The conversation reached its participant limit.',
    { limit },
  );

export const messageTooLarge = (maxBytes: number) =>
  new DomainValidationError(
    'message-too-large',
    'The encrypted message is too large; send it as an attachment.',
    { maxBytes },
  );

export const headerTooLarge = (maxBytes: number) =>
  new DomainValidationError(
    'header-too-large',
    'The encrypted conversation header is too large.',
    { maxBytes },
  );

export const attachmentTooLarge = (maxBytes: number) =>
  new DomainValidationError(
    'attachment-too-large',
    'The encrypted attachment is too large.',
    { maxBytes },
  );
