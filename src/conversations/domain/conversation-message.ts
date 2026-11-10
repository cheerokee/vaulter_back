import { Entity } from '../../shared/domain/entity.js';
import { sameActor, type ConversationActor } from './conversation-actor.js';
import {
  messageReplacesInvalid,
  messageTooLarge,
  notConversationOwner,
} from './conversation-errors.js';
import { MAX_MESSAGE_BYTES } from './conversation-limits.js';
import { assertDeviceId, assertKeyVersion } from './device-id.js';
import { assertEncryptedBlob } from './encrypted-blob.js';

export type ConversationMessageProps = {
  organizationId: string;
  conversationId: string;
  /** Exactly one author: a person or the executor Hub. */
  authorUserId: string | null;
  authorHubId: string | null;
  keyVersion: number;
  /** Encrypted with the conversation key; null only after retention purged a tombstone. */
  encryptedBody: string | null;
  /** Size of the encrypted blob (counts in the space usage). Kept after the purge. */
  bodyBytes: number;
  /** An edit is a new message that references the previous one. */
  replacesMessageId: string | null;
  /** Inbox: a person's message waits until the executor acknowledges it. */
  pending: boolean;
  ackedAt: Date | null;
  sentAt: Date;
  createdAt?: Date;
  deletedAt: Date | null;
};

/** An immutable message of a conversation (spec §4.3). Deleting is a tombstone; editing is a new message. */
export class ConversationMessage extends Entity<ConversationMessageProps> {
  static create(input: {
    id: string;
    organizationId: string;
    conversationId: string;
    author: ConversationActor;
    keyVersion: number;
    encryptedBody: string;
    replacesMessageId: string | null;
    sentAt: Date;
    now: Date;
  }): ConversationMessage {
    const id = assertDeviceId(input.id, 'message-id-invalid');
    if (input.replacesMessageId === id) throw messageReplacesInvalid();
    const bodyBytes = assertEncryptedBlob(
      input.encryptedBody,
      MAX_MESSAGE_BYTES,
      () => messageTooLarge(MAX_MESSAGE_BYTES),
    );
    const fromHub = input.author.kind === 'hub';
    return new ConversationMessage(
      {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        authorUserId: input.author.kind === 'user' ? input.author.userId : null,
        authorHubId: input.author.kind === 'hub' ? input.author.hubId : null,
        keyVersion: assertKeyVersion(input.keyVersion),
        encryptedBody: input.encryptedBody,
        bodyBytes,
        replacesMessageId: input.replacesMessageId,
        // The executor's own message is born acknowledged.
        pending: !fromHub,
        ackedAt: fromHub ? input.now : null,
        sentAt: input.sentAt,
        createdAt: input.now,
        deletedAt: null,
      },
      id,
    );
  }

  static restore(
    props: ConversationMessageProps,
    id: string,
  ): ConversationMessage {
    return new ConversationMessage(props, id);
  }

  snapshot(): ConversationMessageProps {
    return { ...this.props };
  }

  get author(): ConversationActor {
    return this.props.authorHubId !== null
      ? { kind: 'hub', hubId: this.props.authorHubId }
      : { kind: 'user', userId: this.props.authorUserId! };
  }

  /**
   * Idempotent resend: the same id with the same content is the same message; the same id with anything else is a
   * conflict for the use case.
   */
  isSameSubmission(other: ConversationMessage): boolean {
    return (
      other.id === this.id &&
      other.conversationId === this.conversationId &&
      sameActor(other.author, this.author) &&
      other.keyVersion === this.keyVersion &&
      other.encryptedBody === this.encryptedBody &&
      other.replacesMessageId === this.replacesMessageId
    );
  }

  /** The executor took it. The first ack wins; returns whether this call changed anything. */
  ack(now: Date): boolean {
    if (!this.props.pending) return false;
    this.props = { ...this.props, pending: false, ackedAt: now };
    return true;
  }

  /** Each one deletes only their own messages (the executor, its own): 403 otherwise. */
  assertAuthor(actor: ConversationActor): void {
    if (!sameActor(actor, this.author)) throw notConversationOwner();
  }

  tombstone(now: Date): void {
    if (this.props.deletedAt) return;
    this.props = { ...this.props, deletedAt: now };
  }

  /** Retention: the encrypted body goes away after the tombstone; the size stays. */
  purgeBody(): void {
    if (!this.props.deletedAt) {
      throw new Error('purgeBody: only a tombstoned message is purged.');
    }
    this.props = { ...this.props, encryptedBody: null };
  }

  get organizationId(): string {
    return this.props.organizationId;
  }
  get conversationId(): string {
    return this.props.conversationId;
  }
  get authorUserId(): string | null {
    return this.props.authorUserId;
  }
  get authorHubId(): string | null {
    return this.props.authorHubId;
  }
  get keyVersion(): number {
    return this.props.keyVersion;
  }
  get encryptedBody(): string | null {
    return this.props.encryptedBody;
  }
  get bodyBytes(): number {
    return this.props.bodyBytes;
  }
  get replacesMessageId(): string | null {
    return this.props.replacesMessageId;
  }
  get pending(): boolean {
    return this.props.pending;
  }
  get ackedAt(): Date | null {
    return this.props.ackedAt;
  }
  get sentAt(): Date {
    return this.props.sentAt;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
  get deletedAt(): Date | null {
    return this.props.deletedAt;
  }
}
