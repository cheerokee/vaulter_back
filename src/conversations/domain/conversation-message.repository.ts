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
  /** Live pending messages of the conversation (inbox), ascending by sentAt then id. */
  abstract listPending(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<ConversationMessage[]>;
}
