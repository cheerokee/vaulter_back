import type { ConversationState } from '../../domain/conversation-state.js';

/**
 * What the API shows of a conversation: metadata only (the header is encrypted) plus the CALLER's own key copies
 * (every version), so the app or the hub can open it right away.
 */
export type ConversationView = {
  id: string;
  organizationId: string;
  spaceId: string;
  createdByUserId: string;
  ownerUserId: string;
  executorHubId: string | null;
  state: ConversationState;
  lastMessageAt: Date | null;
  currentKeyVersion: number;
  keyRotationRequired: boolean;
  encryptedHeader: string | null;
  headerKeyVersion: number | null;
  movedFromConversationId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  /** Live participants, oldest first (the owner succession order). */
  participants: { userId: string; joinedAt: Date }[];
  keys: { keyVersion: number; wrappedKey: string }[];
};
