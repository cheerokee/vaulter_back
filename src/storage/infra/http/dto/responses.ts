import type {
  CommittedVersionView,
  UploadIntentView,
} from '../../../application/dto/backup-views.js';

export const uploadIntentResponse = (v: UploadIntentView) => ({
  objectId: v.objectId,
  uploadId: v.uploadId,
  url: v.url,
  headers: v.headers,
  expiresAt: v.expiresAt.toISOString(),
});

export const committedVersionResponse = (v: CommittedVersionView) => ({
  uploadId: v.uploadId,
  versionId: v.versionId,
  objectId: v.objectId,
  keyVersion: v.keyVersion,
  sizeBytes: v.sizeBytes,
  sha256: v.sha256,
  uploadedAt: v.uploadedAt.toISOString(),
});
