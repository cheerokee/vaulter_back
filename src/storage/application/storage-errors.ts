import { ConflictError, NotFoundError } from '../../shared/domain/errors.js';

export { objectVersionConflict } from '../domain/backup-object.js';

export function uploadNotFound(uploadId: string): NotFoundError {
  return new NotFoundError('upload-not-found', 'The upload was not found.', {
    uploadId,
  });
}

/**
 * 409, retryable: the journal mark of this attempt disappeared before its S3 write (a reconcile sweep cleared it while
 * the request stalled). No S3 write happens without a mark; the client simply repeats the request.
 */
export function storageBusy(): ConflictError {
  return new ConflictError(
    'storage-busy',
    'The storage was busy with this object; repeat the request.',
  );
}

/** 404: no committed version with this id for this object of this space, live or still in the 30-day trash. */
export function versionNotFound(
  objectId: string,
  versionId: string,
): NotFoundError {
  return new NotFoundError('version-not-found', 'The version was not found.', {
    objectId,
    versionId,
  });
}
