import type { ConversationScope } from './conversation-actor.js';
import type { ConversationAttachment } from './conversation-attachment.js';

export abstract class ConversationAttachmentRepository {
  abstract create(
    scope: ConversationScope,
    attachment: ConversationAttachment,
  ): Promise<void>;
  abstract findById(
    scope: ConversationScope,
    id: string,
    options?: { withDeleted?: boolean },
  ): Promise<ConversationAttachment | null>;
  /** Writes what may change after insert: status, S3 version, journal mark, message link, tombstone. */
  abstract save(
    scope: ConversationScope,
    attachment: ConversationAttachment,
  ): Promise<void>;
}
