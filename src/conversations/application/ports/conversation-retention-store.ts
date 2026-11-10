import type { PurgedAttachment } from '../../domain/conversation-attachment.repository.js';

/** A conversation with encrypted content past the retention window. */
export type RetentionCandidate = {
  organizationId: string;
  conversationId: string;
};

/** What one conversation lost in a retention pass (committed together). */
export type RetentionPurge = {
  messages: number;
  messageBytes: number;
  /** Marked `purged` with a fresh journal mark: their S3 versions are deleted after the COMMIT. */
  attachments: PurgedAttachment[];
  headerPurged: boolean;
};

/**
 * The database side of the retention routine (spec §4.4.1). The implementation runs with the OWNER login: a tombstoned
 * conversation is invisible to every runtime RLS context (its last participant left), and the usage triggers must see
 * it. Every "past the window" comparison uses the database clock (`now()`).
 */
export abstract class ConversationRetentionStore {
  /**
   * Conversations (any organization, tombstoned or not) that still hold encrypted content past the window: a message
   * body or a committed attachment tombstoned more than `retentionDays` ago, or anything of a conversation tombstoned
   * more than `retentionDays` ago (its header included). Ordered by (space id, id): the multi-conversation order.
   */
  abstract candidates(retentionDays: number): Promise<RetentionCandidate[]>;
  /**
   * In ONE transaction: the conversation `FOR UPDATE` (the order of every writer: conversation -> its rows -> the usage
   * counter; never the space), message bodies nulled (a message of a tombstoned conversation gets the conversation's
   * tombstone too), committed attachments `purged` with the journal mark renewed, and the header of a conversation
   * tombstoned past the window nulled. The usage triggers take the bytes out of the space usage.
   */
  abstract purge(
    candidate: RetentionCandidate,
    retentionDays: number,
  ): Promise<RetentionPurge>;
}
