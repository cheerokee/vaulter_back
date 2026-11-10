import type {
  ConversationActor,
  ConversationScope,
} from './conversation-actor.js';

/** Sealed copy of one key version for one recipient (a participant or the executor Hub). */
export type ConversationKeyGrant = {
  keyVersion: number;
  recipient: ConversationActor;
  wrappedKey: string;
};

export abstract class ConversationKeyGrantRepository {
  /** Inserts, or replaces the live copy / revives the latest tombstone of (version, recipient). */
  abstract put(
    scope: ConversationScope,
    conversationId: string,
    grant: ConversationKeyGrant,
  ): Promise<void>;
  /** Live copies of the recipient, ascending by version. */
  abstract listFor(
    scope: ConversationScope,
    conversationId: string,
    recipient: ConversationActor,
  ): Promise<{ keyVersion: number; wrappedKey: string }[]>;
  /** Tombstones every live copy of the recipient; returns how many. */
  abstract removeFor(
    scope: ConversationScope,
    conversationId: string,
    recipient: ConversationActor,
  ): Promise<number>;
}
