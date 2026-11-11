import type { ConversationMessage } from '../../domain/conversation-message.js';

/** What the API returns about a message: metadata only (the sender already has the encrypted body). */
export type MessageView = {
  id: string;
  conversationId: string;
  authorUserId: string | null;
  authorHubId: string | null;
  /** Written by the cloud (reserve executor). */
  authorCloud: boolean;
  keyVersion: number;
  bodyBytes: number;
  replacesMessageId: string | null;
  pending: boolean;
  ackedAt: Date | null;
  sentAt: Date;
  deletedAt: Date | null;
};

export function messageView(m: ConversationMessage): MessageView {
  return {
    id: m.id,
    conversationId: m.conversationId,
    authorUserId: m.authorUserId,
    authorHubId: m.authorHubId,
    authorCloud: m.authorCloud,
    keyVersion: m.keyVersion,
    bodyBytes: m.bodyBytes,
    replacesMessageId: m.replacesMessageId,
    pending: m.pending,
    ackedAt: m.ackedAt,
    sentAt: m.sentAt,
    deletedAt: m.deletedAt,
  };
}
