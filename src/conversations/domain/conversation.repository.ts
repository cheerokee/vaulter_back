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
  /**
   * `FOR UPDATE` on the live conversation; requires an active unit of work. The first lock of every mutation.
   * `share` (`FOR SHARE`): an attachment confirmation, which only reads the key state while it copies in S3 (a key
   * rotation waits for it; confirmations and messages of other conversations do not).
   */
  abstract lockById(
    scope: ConversationScope,
    id: string,
    mode?: 'update' | 'share',
  ): Promise<Conversation | null>;
  /**
   * Writes the mutable fields (owner, executor, state, times, key versions, header, tombstone); never the participants.
   * The new row must stay visible to the scope: clearing or replacing the executor (`loseExecutor`, `changeExecutor`)
   * must run in a PARTICIPANT's user scope (e.g. the Hub owner), never in the Hub's own scope (Postgres 42501). Throws
   * `conversation-not-found` when nothing was updated (not visible).
   */
  abstract save(
    scope: ConversationScope,
    conversation: Conversation,
  ): Promise<void>;
  /** Live conversations of a space where the user is a live participant, by (space id, id): the multi-lock order. */
  abstract idsWithParticipant(
    scope: ConversationScope,
    spaceId: string,
    userId: string,
  ): Promise<string[]>;
  /**
   * Live conversations of the organization whose executor is the Hub (only of `spaceId` when given), by (space id, id):
   * every path that locks several conversations locks them in this order.
   */
  abstract idsWithExecutor(
    scope: ConversationScope,
    hubId: string,
    spaceId?: string | null,
  ): Promise<string[]>;
}
