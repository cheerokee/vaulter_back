import type { ConversationScope } from './conversation-actor.js';
import type { ConversationMessage } from './conversation-message.js';

/** Who acknowledged a message: the executor Hub or the cloud (reserve executor). */
export type AckedBy = { kind: 'hub'; hubId: string } | { kind: 'cloud' };

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
  /**
   * The executor changed or was lost (a Hub, or the cloud when its reserve goes off): every live message of the
   * conversation that `by` acknowledged and that has no later message authored by it in the conversation (it never
   * answered: it may have died with it in its queue) goes back to `pending`, so the next executor takes it. Returns
   * their ids. Inside `UnitOfWork.run`, with the conversation locked, in a PARTICIPANT's scope (the old executor may
   * no longer see the conversation).
   */
  abstract requeueAckedBy(
    scope: ConversationScope,
    conversationId: string,
    by: AckedBy,
  ): Promise<string[]>;
  /** Whether `by` (Hub or cloud) wrote a message in the conversation after `after` (it answered what it acked). */
  abstract answeredAfter(
    scope: ConversationScope,
    conversationId: string,
    by: AckedBy,
    after: Date,
  ): Promise<boolean>;
  /** The last `limit` live messages of the conversation (with their bodies), oldest first: the cloud's history. */
  abstract listRecent(
    scope: ConversationScope,
    conversationId: string,
    limit: number,
  ): Promise<ConversationMessage[]>;
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
