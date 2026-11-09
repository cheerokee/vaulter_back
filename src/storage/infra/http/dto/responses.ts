import { pageResponse } from '../../../../shared/infra/http/cursor-pagination.query.js';
import type {
  CommittedVersionView,
  UploadIntentView,
} from '../../../application/dto/backup-views.js';
import type { DownloadUrlView } from '../../../application/get-download-url.use-case.js';
import type { ListObjectsResult } from '../../../application/list-objects.use-case.js';
import type {
  ListedObject,
  ListedVersion,
  StoredObjectVersion,
} from '../../../application/ports/backup-index-reader.js';

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

const listedVersionResponse = (v: ListedVersion) => ({
  versionId: v.versionId,
  keyVersion: v.keyVersion,
  sizeBytes: v.sizeBytes,
  sha256: v.sha256,
  uploadedAt: v.uploadedAt.toISOString(),
});

const listedObjectResponse = (o: ListedObject) => ({
  objectId: o.objectId,
  deleted: o.deleted,
  deletedAt: o.deletedAt?.toISOString() ?? null,
  currentVersion: o.currentVersion
    ? listedVersionResponse(o.currentVersion)
    : null,
});

const storedVersionResponse = (v: StoredObjectVersion) => ({
  objectId: v.objectId,
  ...listedVersionResponse(v),
  supersededAt: v.supersededAt?.toISOString() ?? null,
  current: v.current,
});

/** `{ items, nextCursor, asOf }`: objects (current/trash) or the versions of one object. */
export const objectListingResponse = (r: ListObjectsResult) => ({
  ...(r.include === 'versions'
    ? pageResponse(r.page, storedVersionResponse)
    : pageResponse(r.page, listedObjectResponse)),
  asOf: r.asOf.toISOString(),
});

export const downloadUrlResponse = (v: DownloadUrlView) => ({
  url: v.url,
  expiresAt: v.expiresAt.toISOString(),
});
