import type {
  AttachmentStatus,
  ConversationAttachment,
} from '../../domain/conversation-attachment.js';

/** What the API returns about an attachment: metadata only (never name or type; the bytes go straight to S3). */
export type AttachmentView = {
  id: string;
  conversationId: string;
  keyVersion: number;
  sizeBytes: number;
  sha256: string;
  status: AttachmentStatus;
  uploadedByUserId: string | null;
  uploadedByHubId: string | null;
  createdAt: Date | null;
  deletedAt: Date | null;
};

export function attachmentView(a: ConversationAttachment): AttachmentView {
  return {
    id: a.id,
    conversationId: a.conversationId,
    keyVersion: a.keyVersion,
    sizeBytes: a.sizeBytes,
    sha256: a.sha256,
    status: a.status,
    uploadedByUserId: a.uploader.kind === 'user' ? a.uploader.userId : null,
    uploadedByHubId: a.uploader.kind === 'hub' ? a.uploader.hubId : null,
    createdAt: a.createdAt ?? null,
    deletedAt: a.deletedAt,
  };
}
