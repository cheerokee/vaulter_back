import type { ConversationView } from '../../../application/dto/conversation-view.js';
import type { MessageView } from '../../../application/dto/message-view.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Explicit response shape (camelCase, ISO 8601 UTC): only metadata and the caller's own key copies. */
export function conversationResponse(v: ConversationView) {
  return {
    id: v.id,
    organizationId: v.organizationId,
    spaceId: v.spaceId,
    createdByUserId: v.createdByUserId,
    ownerUserId: v.ownerUserId,
    executorHubId: v.executorHubId,
    state: v.state,
    lastMessageAt: iso(v.lastMessageAt),
    currentKeyVersion: v.currentKeyVersion,
    keyRotationRequired: v.keyRotationRequired,
    encryptedHeader: v.encryptedHeader,
    headerKeyVersion: v.headerKeyVersion,
    movedFromConversationId: v.movedFromConversationId,
    createdAt: iso(v.createdAt),
    updatedAt: iso(v.updatedAt),
    participants: v.participants.map((p) => ({
      userId: p.userId,
      joinedAt: p.joinedAt.toISOString(),
    })),
    keys: v.keys.map((k) => ({
      keyVersion: k.keyVersion,
      wrappedKey: k.wrappedKey,
    })),
  };
}

/** A message: metadata only (never the encrypted body, which the sender already has; the feeds carry it). */
export function messageResponse(v: MessageView) {
  return {
    id: v.id,
    conversationId: v.conversationId,
    authorUserId: v.authorUserId,
    authorHubId: v.authorHubId,
    keyVersion: v.keyVersion,
    bodyBytes: v.bodyBytes,
    replacesMessageId: v.replacesMessageId,
    pending: v.pending,
    ackedAt: iso(v.ackedAt),
    sentAt: v.sentAt.toISOString(),
    deletedAt: iso(v.deletedAt),
  };
}
