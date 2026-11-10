import type { ConversationScope } from './conversation-actor.js';
import type { ConversationMessage } from './conversation-message.js';

export abstract class ConversationMessageRepository {
  /** Idempotent insert by id: false when a message with this id already exists (compare with `isSameSubmission`). */
  abstract insertIfAbsent(
    scope: ConversationScope,
    message: ConversationMessage,
  ): Promise<boolean>;
  abstract findById(
    scope: ConversationScope,
    id: string,
    options?: { withDeleted?: boolean },
  ): Promise<ConversationMessage | null>;
  /** Writes what may change after insert: ack, tombstone, purged body. */
  abstract save(
    scope: ConversationScope,
    message: ConversationMessage,
  ): Promise<void>;
  /**
   * The database clock at this instant (`clock_timestamp()`): `sentAt`, `ackedAt` and the tombstones come from it, read
   * after the locks, so the times of one conversation follow the order of its writes.
   */
  abstract databaseNow(): Promise<Date>;
  /** Live pending messages of the conversation (inbox), ascending by sentAt then id. */
  abstract listPending(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<ConversationMessage[]>;
  /**
   * Nulls the encrypted body of every tombstoned message of the conversation that still has one (its trash). The usage
   * trigger takes the bytes out of the space usage and trash. Inside `UnitOfWork.run`, with the conversation locked.
   */
  abstract purgeTrash(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<{ messages: number; bytes: number }>;
}
