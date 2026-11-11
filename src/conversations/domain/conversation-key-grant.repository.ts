import type { ActorRef, ConversationScope } from './conversation-actor.js';

/**
 * Sealed copy of one key version for one recipient: a participant, the executor Hub or the server key (`cloud`, the
 * reserve executor; never in a feed).
 */
export type ConversationKeyGrant = {
  keyVersion: number;
  recipient: ActorRef;
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
    recipient: ActorRef,
  ): Promise<{ keyVersion: number; wrappedKey: string }[]>;
  /** Tombstones every live copy of a person or Hub; returns how many. */
  abstract removeFor(
    scope: ConversationScope,
    conversationId: string,
    recipient: Exclude<ActorRef, { kind: 'cloud' }>,
  ): Promise<number>;
  /**
   * DELETES (no tombstone) every copy for the server key: key material the server can open, delivered by no feed
   * (migration ConversationCloudReserve). In a participant's scope (the cloud never writes copies). Returns how many.
   */
  abstract deleteServerCopies(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<number>;
}
