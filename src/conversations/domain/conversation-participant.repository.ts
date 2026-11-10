import type { ConversationScope } from './conversation-actor.js';
import type { LiveParticipant } from './participation-rules.js';

export abstract class ConversationParticipantRepository {
  /**
   * Live participation for the user: revives the latest tombstoned row of the pair (a returning person keeps one
   * row) or inserts. No-op when already live. The conversation must be visible in the scope.
   */
  abstract add(
    scope: ConversationScope,
    conversationId: string,
    userId: string,
    joinedAt: Date,
  ): Promise<void>;
  /** Live participants, oldest first (joinedAt, then user id). */
  abstract listLive(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<LiveParticipant[]>;
  /**
   * Tombstone of the live participation; false when there was none. The person loses the conversation right after
   * (the database recomputes `participant_user_ids`): when it is the caller leaving, do everything else on the
   * conversation first (owner, executor, key copies, conversation tombstone) and this last.
   */
  abstract remove(
    scope: ConversationScope,
    conversationId: string,
    userId: string,
  ): Promise<boolean>;
}
