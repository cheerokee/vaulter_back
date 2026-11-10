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

/** The device id is already used by another conversation (or by one the caller can no longer see). */
export const conversationIdConflict = () =>
  new ConflictError(
    'conversation-id-conflict',
    'Another conversation already uses this id.',
  );

/** The message id is already used: by another message, author or conversation (or by one the caller cannot see). */
export const messageIdConflict = () =>
  new ConflictError(
    'message-id-conflict',
    'Another message already uses this id.',
  );

/** Unknown, deleted (for an ack) or of another conversation: always the same 404. */
export const messageNotFound = () =>
  new NotFoundError('message-not-found', 'The message was not found.');

/** An edit must replace a live message of the same conversation. */
export const messageReplacesInvalid = () =>
  new DomainValidationError(
    'message-replaces-invalid',
    'The replaced message must be a live message of this conversation.',
  );

/**
 * The same rule (and code) as the backup of the space (`space-storage-full`): the whole usage of the space, already
 * counting the new content, must fit its size.
 */
export function assertSpaceFits(quotaBytes: number, usedBytes: number): void {
  const missingBytes = usedBytes - quotaBytes;
  if (missingBytes > 0) {
    throw new DomainValidationError(
      'space-storage-full',
      'The space does not have room for this content.',
      { missingBytes },
    );
  }
}

/** Unknown, of another conversation or uploader, not committed (download) or past its window (confirm): the same 404. */
export const attachmentNotFound = () =>
  new NotFoundError('attachment-not-found', 'The attachment was not found.');

/** The attachment id is already used by another upload request (or by one the caller cannot see). */
export const attachmentIdConflict = () =>
  new ConflictError(
    'attachment-id-conflict',
    'Another attachment already uses this id.',
  );

/** The bytes in the provisional object are not the declared ones (or nothing was uploaded): same code as the backup. */
export const attachmentUploadMismatch = (attachmentId: string) =>
  new DomainValidationError(
    'upload-mismatch',
    'The uploaded object does not match the declared size and checksum.',
    { attachmentId },
  );

/**
 * A move must go to another space (create with `movedFrom`), and completing it must name the conversation created
 * with `movedFrom` = this one.
 */
export const conversationMoveInvalid = () =>
  new DomainValidationError(
    'conversation-move-invalid',
    'The move must go to a conversation of another space created from this one.',
  );
