import { ConflictError, NotFoundError } from '../../shared/domain/errors.js';
import { isLockTimeout } from '../../shared/infra/db/unit-of-work.js';

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

/**
 * A lock wait past `STORAGE_LOCK_TIMEOUT_MS` (55P03: someone held the space or an object longer, e.g. a big
 * confirmation) becomes the same retryable 409 `storage-busy`; any other error is returned unchanged.
 */
export function lockTimeoutAsBusy(error: unknown): unknown {
  return isLockTimeout(error) ? storageBusy() : error;
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
