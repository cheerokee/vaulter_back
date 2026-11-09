import { NotFoundError } from '../../shared/domain/errors.js';

export { objectVersionConflict } from '../domain/backup-object.js';

export function uploadNotFound(uploadId: string): NotFoundError {
  return new NotFoundError('upload-not-found', 'The upload was not found.', {
    uploadId,
  });
}
