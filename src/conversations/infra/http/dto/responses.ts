import type { ConversationView } from '../../../application/dto/conversation-view.js';

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
