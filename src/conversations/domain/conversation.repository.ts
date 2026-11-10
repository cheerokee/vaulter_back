import type { ConversationScope } from './conversation-actor.js';
import type { Conversation } from './conversation.js';

/**
 * Every method runs in the given scope (organization + one principal): row-level security shows only conversations
 * where the person is a live participant or the Hub is the executor, so "not visible" and "nonexistent" look the same.
 */
export abstract class ConversationRepository {
  /** Inserts the conversation and its owner's participation (joined at `createdAt`), in one transaction. */
  abstract create(
    scope: ConversationScope,
    conversation: Conversation,
  ): Promise<void>;
  abstract findById(
    scope: ConversationScope,
    id: string,
    options?: { withDeleted?: boolean },
  ): Promise<Conversation | null>;
  /** `FOR UPDATE` on the live conversation; requires an active unit of work. The first lock of every mutation. */
  abstract lockById(
    scope: ConversationScope,
    id: string,
  ): Promise<Conversation | null>;
  /** Writes the mutable fields (owner, executor, state, times, key versions, header, tombstone); never the participants. */
  abstract save(
    scope: ConversationScope,
    conversation: Conversation,
  ): Promise<void>;
  /** Live conversations of a space where the user is a live participant, ascending by id. */
  abstract idsWithParticipant(
    scope: ConversationScope,
    spaceId: string,
    userId: string,
  ): Promise<string[]>;
  /** Live conversations of the organization whose executor is the Hub, ascending by id. */
  abstract idsWithExecutor(
    scope: ConversationScope,
    hubId: string,
  ): Promise<string[]>;
}
