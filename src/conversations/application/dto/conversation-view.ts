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
  /**
   * The cloud is a reserve executor (spec active-cloud §4.3): every key rotation must also seal the new version for the
   * server key (`GET /cloud/server-key`), else 409 `key-rotation-mismatch` with `missingServer`.
   */
  cloudReserve: boolean;
  /** The owner switched the reserve off: only the owner switches it on again. */
  cloudReserveDeclined: boolean;
  /** "Responder pela nuvem" in the whole conversation (only with the reserve). */
  cloudAnswer: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
  /** Live participants, oldest first (the owner succession order). */
  participants: { userId: string; joinedAt: Date }[];
  keys: { keyVersion: number; wrappedKey: string }[];
};
