import type { BackupObjectVersion } from '../../domain/backup-object-version.js';

export type UploadIntentInput = {
  objectId: string;
  keyVersion: number;
  sizeBytes: number;
  sha256: string;
  /** The version this upload replaces; null for a new (or deleted) object. */
  replacesVersionId: string | null;
};

export type UploadIntentView = {
  objectId: string;
  uploadId: string;
  url: string;
  /** Must be sent verbatim with the PUT (signed: size, checksum, provisional tag). */
  headers: Record<string, string>;
  /** When the presigned URL stops working. */
  expiresAt: Date;
};

/** A committed version; `versionId` is the `uploadId` of its intent. */
export type CommittedVersionView = {
  uploadId: string;
  versionId: string;
  objectId: string;
  keyVersion: number;
  sizeBytes: number;
  sha256: string;
  uploadedAt: Date;
};

export type DeleteObjectInput = { objectId: string; replacesVersionId: string };

export function committedVersionView(
  v: BackupObjectVersion,
): CommittedVersionView {
  if (!v.committedAt) throw new Error(`version ${v.id} is not committed`);
  return {
    uploadId: v.id,
    versionId: v.id,
    objectId: v.objectId,
    keyVersion: v.keyVersion,
    sizeBytes: v.sizeBytes,
    sha256: v.sha256,
    uploadedAt: v.committedAt,
  };
}
