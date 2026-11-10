import type {
  ConversationActor,
  ConversationScope,
} from './conversation-actor.js';
import type { ConversationAttachment } from './conversation-attachment.js';

/** An attachment whose S3 write mark is old (the reconcile sweep repairs it). */
export type MarkedAttachmentRef = {
  organizationId: string;
  attachmentId: string;
};

export abstract class ConversationAttachmentRepository {
  /** Inserts; false when the id already exists (in any conversation, even one the scope cannot see). */
  abstract insertIfAbsent(
    scope: ConversationScope,
    attachment: ConversationAttachment,
  ): Promise<boolean>;
  abstract findById(
    scope: ConversationScope,
    id: string,
    options?: { withDeleted?: boolean },
  ): Promise<ConversationAttachment | null>;
  /** `FOR UPDATE` (the "object lock": every S3 write of the attachment happens under it). Inside `UnitOfWork.run`. */
  abstract lockById(
    scope: ConversationScope,
    id: string,
  ): Promise<ConversationAttachment | null>;
  /** Writes what may change after insert: status, S3 version, upload window, message link, tombstone (never the mark). */
  abstract save(
    scope: ConversationScope,
    attachment: ConversationAttachment,
  ): Promise<void>;
  /** Database clock (`clock_timestamp()`). */
  abstract databaseNow(): Promise<Date>;

  // Diário das gravações no S3 (mesma regra do índice do backup; CLAUDE.md, "Módulo storage").
  /**
   * Renews the mark of a live pending upload of `uploader` to the database clock and returns it (null: nothing to
   * mark). Called in its own short transaction, committed BEFORE the unit of work that writes to S3.
   */
  abstract markWrite(
    scope: ConversationScope,
    id: string,
    uploader: ConversationActor,
  ): Promise<Date | null>;
  /** The current mark (read under the row lock, right before the S3 write). */
  abstract writeMark(
    scope: ConversationScope,
    id: string,
  ): Promise<Date | null>;
  /** Marks older than `olderThanMinutes` (database clock), any organization (reconcile context, marked rows only). */
  abstract staleWriteMarks(
    olderThanMinutes: number,
  ): Promise<MarkedAttachmentRef[]>;
  /**
   * Locks a MARKED attachment `FOR UPDATE` in the reconcile context (no participant needed: the repair after a failed
   * request and the sweep). Null when gone or not marked anymore. Inside `UnitOfWork.run`.
   */
  abstract lockMarked(
    organizationId: string,
    id: string,
  ): Promise<ConversationAttachment | null>;
  /** Clears the mark when older than `olderThanMinutes` (only the sweep, after the repair, under the lock). */
  abstract clearWriteMark(
    organizationId: string,
    id: string,
    olderThanMinutes: number,
  ): Promise<void>;
}
