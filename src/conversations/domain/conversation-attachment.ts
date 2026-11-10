import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';
import { attachmentTooLarge } from './conversation-errors.js';
import { MAX_ATTACHMENT_BYTES } from './conversation-limits.js';
import { assertDeviceId, assertKeyVersion } from './device-id.js';

/** pending (upload intent, reserves the size until `uploadExpiresAt`) -> committed (in S3) -> purged (gone from S3). */
export type AttachmentStatus = 'pending' | 'committed' | 'purged';

export type ConversationAttachmentProps = {
  organizationId: string;
  conversationId: string;
  messageId: string | null;
  keyVersion: number;
  sizeBytes: number;
  /** sha256 of the whole encrypted blob, lowercase hex. */
  sha256: string;
  status: AttachmentStatus;
  s3VersionId: string | null;
  /** Journal of S3 writes (same meaning as in the storage index): some write started at or after this instant. */
  s3WriteStartedAt: Date | null;
  uploadExpiresAt: Date;
  createdAt?: Date;
  deletedAt: Date | null;
};

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Index row of an encrypted attachment (spec §4.4): object in S3 at
 * `orgs/<orgId>/spaces/<spaceId>/conversations/<conversationId>/<attachmentId>`. Only ids, size, sha256, key version and
 * times: never name or type.
 */
export class ConversationAttachment extends Entity<ConversationAttachmentProps> {
  static create(input: {
    id: string;
    organizationId: string;
    conversationId: string;
    messageId: string | null;
    keyVersion: number;
    sizeBytes: number;
    sha256: string;
    uploadExpiresAt: Date;
  }): ConversationAttachment {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) {
      throw new DomainValidationError(
        'attachment-size-invalid',
        'The attachment size must be a whole number of bytes >= 1.',
      );
    }
    if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw attachmentTooLarge(MAX_ATTACHMENT_BYTES);
    }
    if (typeof input.sha256 !== 'string' || !SHA256.test(input.sha256)) {
      throw new DomainValidationError(
        'attachment-sha256-invalid',
        'The sha256 must be 64 lowercase hex characters.',
      );
    }
    return new ConversationAttachment(
      {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        keyVersion: assertKeyVersion(input.keyVersion),
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        status: 'pending',
        s3VersionId: null,
        s3WriteStartedAt: null,
        uploadExpiresAt: input.uploadExpiresAt,
        deletedAt: null,
      },
      assertDeviceId(input.id, 'attachment-id-invalid'),
    );
  }

  static restore(
    props: ConversationAttachmentProps,
    id: string,
  ): ConversationAttachment {
    return new ConversationAttachment(props, id);
  }

  snapshot(): ConversationAttachmentProps {
    return { ...this.props };
  }

  commit(s3VersionId: string): void {
    if (this.props.status !== 'pending') {
      throw new ConflictError(
        'attachment-not-pending',
        'The attachment is not waiting for confirmation.',
      );
    }
    this.props = { ...this.props, status: 'committed', s3VersionId };
  }

  /** Gone from S3 (trash emptied or retention): leaves the usage; the row stays. */
  purge(): void {
    if (this.props.status !== 'committed') {
      throw new ConflictError(
        'attachment-not-committed',
        'Only a committed attachment can be purged.',
      );
    }
    this.props = { ...this.props, status: 'purged' };
  }

  tombstone(now: Date): void {
    if (this.props.deletedAt) return;
    this.props = { ...this.props, deletedAt: now };
  }

  get organizationId(): string {
    return this.props.organizationId;
  }
  get conversationId(): string {
    return this.props.conversationId;
  }
  get messageId(): string | null {
    return this.props.messageId;
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
  get status(): AttachmentStatus {
    return this.props.status;
  }
  get s3VersionId(): string | null {
    return this.props.s3VersionId;
  }
  get s3WriteStartedAt(): Date | null {
    return this.props.s3WriteStartedAt;
  }
  get uploadExpiresAt(): Date {
    return this.props.uploadExpiresAt;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
  get deletedAt(): Date | null {
    return this.props.deletedAt;
  }
}
