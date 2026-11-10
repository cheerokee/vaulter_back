import { DomainValidationError } from '../../shared/domain/errors.js';
import { UPLOAD_WINDOW_MS } from './backup-limits.js';
import { BackupRules } from './backup-rules.js';

/**
 * `purged`: a committed version removed for good from the trash (the Gestor emptied it, or it fell beyond the per-object
 * cap of old versions). It no longer counts in the usage, is never listed and never downloadable.
 */
export type BackupVersionStatus =
  'pending' | 'committed' | 'expired' | 'purged';

/** A version the purge just removed from the index: what the bucket delete (after the COMMIT) needs. */
export type PurgedVersion = {
  id: string;
  objectId: string;
  s3VersionId: string;
  sizeBytes: number;
};

/** Who uploaded: the hub with its own token, or a person (the hub on behalf of the logged-in person). */
export type BackupUploader = { hubId: string } | { userId: string };

export type BackupObjectVersionProps = {
  /** Server-generated UUID v7: the `uploadId` of the intent and, once committed, the `versionId`. */
  id: string;
  organizationId: string;
  spaceId: string;
  objectId: string;
  keyVersion: number;
  sizeBytes: number;
  /** Lowercase hex sha256 of the encrypted blob. */
  sha256: string;
  status: BackupVersionStatus;
  replacesVersionId: string | null;
  s3VersionId: string | null;
  uploader: BackupUploader;
  uploadExpiresAt: Date;
  committedAt: Date | null;
  supersededAt: Date | null;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** What the bucket says about the provisional upload (null: nothing there). */
export type UploadedBlob = {
  sizeBytes: number;
  sha256Hex: string | null;
} | null;

/**
 * The provisional object is exactly what was declared. A missing object, a missing/zero size or a missing sha256 (e.g.
 * a multipart upload) never matches. Shared with other indexes of the same bucket (exported by `application/object-uploads`).
 */
export function isUploadedAsDeclared(
  blob: UploadedBlob,
  sizeBytes: number,
  sha256: string,
): boolean {
  return (
    blob !== null &&
    blob.sizeBytes > 0 &&
    blob.sha256Hex !== null &&
    blob.sizeBytes === sizeBytes &&
    blob.sha256Hex === sha256
  );
}

/**
 * One version of an object. Born `pending` (an upload intent: it reserves its size in the space until
 * `uploadExpiresAt`), becomes `committed` when the confirmation finds the declared bytes in the bucket and copies them
 * to the final key, or `expired` when a newer intent of the same uploader replaces it.
 */
export class BackupObjectVersion {
  private constructor(private props: BackupObjectVersionProps) {}

  static restore(props: BackupObjectVersionProps): BackupObjectVersion {
    return new BackupObjectVersion({ ...props });
  }

  static request(input: {
    id: string;
    organizationId: string;
    spaceId: string;
    objectId: string;
    keyVersion: number;
    sizeBytes: number;
    sha256: string;
    replacesVersionId: string | null;
    uploader: BackupUploader;
    now: Date;
  }): BackupObjectVersion {
    BackupRules.assertObjectSize(input.objectId, input.sizeBytes);
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) {
      throw new DomainValidationError(
        'validation-failed',
        'sizeBytes must be a positive integer.',
      );
    }
    if (!SHA256_HEX.test(input.sha256)) {
      throw new DomainValidationError(
        'validation-failed',
        'sha256 must be 64 lowercase hex characters.',
      );
    }
    return new BackupObjectVersion({
      id: input.id,
      organizationId: input.organizationId,
      spaceId: input.spaceId,
      objectId: input.objectId,
      keyVersion: input.keyVersion,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      status: 'pending',
      replacesVersionId: input.replacesVersionId,
      s3VersionId: null,
      uploader: input.uploader,
      uploadExpiresAt: new Date(input.now.getTime() + UPLOAD_WINDOW_MS),
      committedAt: null,
      supersededAt: null,
    });
  }

  /** A pending intent still inside its window (it reserves space and can be confirmed). */
  isConfirmable(now: Date): boolean {
    return this.props.status === 'pending' && this.props.uploadExpiresAt > now;
  }

  /**
   * The provisional object must be exactly what was declared. A missing object, a missing/zero size or a missing
   * sha256 (e.g. a multipart upload) is a mismatch, never a success: 422 `upload-mismatch`.
   */
  assertUploaded(blob: UploadedBlob): void {
    if (!isUploadedAsDeclared(blob, this.props.sizeBytes, this.props.sha256)) {
      throw new DomainValidationError(
        'upload-mismatch',
        'The uploaded object does not match the declared size and checksum.',
        { uploadId: this.props.id },
      );
    }
  }

  commit(s3VersionId: string, now: Date): void {
    if (this.props.status !== 'pending') {
      throw new Error(
        `commit: version ${this.props.id} is ${this.props.status}`,
      );
    }
    this.props = {
      ...this.props,
      status: 'committed',
      s3VersionId,
      committedAt: now,
    };
  }

  get id(): string {
    return this.props.id;
  }
  get organizationId(): string {
    return this.props.organizationId;
  }
  get spaceId(): string {
    return this.props.spaceId;
  }
  get objectId(): string {
    return this.props.objectId;
  }
  get keyVersion(): number {
    return this.props.keyVersion;
  }
  get sizeBytes(): number {
    return this.props.sizeBytes;
  }
  get sha256(): string {
    return this.props.sha256;
  }
  get status(): BackupVersionStatus {
    return this.props.status;
  }
  get replacesVersionId(): string | null {
    return this.props.replacesVersionId;
  }
  get s3VersionId(): string | null {
    return this.props.s3VersionId;
  }
  get uploader(): BackupUploader {
    return this.props.uploader;
  }
  get uploadExpiresAt(): Date {
    return this.props.uploadExpiresAt;
  }
  get committedAt(): Date | null {
    return this.props.committedAt;
  }
  get supersededAt(): Date | null {
    return this.props.supersededAt;
  }
}
