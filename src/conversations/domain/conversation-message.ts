import { Entity } from '../../shared/domain/entity.js';
import { sameActor, type ActorRef } from './conversation-actor.js';
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
  /** Exactly one author: a person, the executor Hub or the cloud (reserve executor). */
  authorUserId: string | null;
  authorHubId: string | null;
  authorCloud: boolean;
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
  /** The executor Hub that acknowledged it (a person's message); null while pending and for a Hub's own message. */
  ackedByHubId: string | null;
  /** The cloud (reserve executor) acknowledged it; never together with `ackedByHubId`. */
  ackedByCloud: boolean;
  /**
   * "Responder pela nuvem" for this message (a person's message only): with the reserve on, the cloud takes it right
   * away instead of waiting for the Hub (spec active-cloud §4.3). Set when sent, never changed.
   */
  cloudAnswerRequested: boolean;
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
    author: ActorRef;
    keyVersion: number;
    encryptedBody: string;
    replacesMessageId: string | null;
    /** A person asks the cloud to answer this one at once (ignored for the executor's own messages: they are born acked). */
    cloudAnswerRequested?: boolean;
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
    // The executor's (Hub or cloud) own message is born acknowledged.
    const fromExecutor = input.author.kind !== 'user';
    return new ConversationMessage(
      {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        authorUserId: input.author.kind === 'user' ? input.author.userId : null,
        authorHubId: input.author.kind === 'hub' ? input.author.hubId : null,
        authorCloud: input.author.kind === 'cloud',
        keyVersion: assertKeyVersion(input.keyVersion),
        encryptedBody: input.encryptedBody,
        bodyBytes,
        replacesMessageId: input.replacesMessageId,
        pending: !fromExecutor,
        ackedAt: fromExecutor ? input.now : null,
        ackedByHubId: null,
        ackedByCloud: false,
        cloudAnswerRequested:
          !fromExecutor && (input.cloudAnswerRequested ?? false),
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

  get author(): ActorRef {
    if (this.props.authorCloud) return { kind: 'cloud' };
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

  /**
   * The executor took it: the Hub or the cloud (reserve executor). The first ack wins (never both); returns whether this
   * call changed anything.
   */
  ack(
    now: Date,
    by: { kind: 'hub'; hubId: string } | { kind: 'cloud' },
  ): boolean {
    if (!this.props.pending) return false;
    this.props = {
      ...this.props,
      pending: false,
      ackedAt: now,
      ackedByHubId: by.kind === 'hub' ? by.hubId : null,
      ackedByCloud: by.kind === 'cloud',
    };
    return true;
  }

  /** Each one deletes only their own messages (the executor, its own): 403 otherwise. */
  assertAuthor(actor: ActorRef): void {
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
  get ackedByHubId(): string | null {
    return this.props.ackedByHubId;
  }
  get authorCloud(): boolean {
    return this.props.authorCloud;
  }
  get ackedByCloud(): boolean {
    return this.props.ackedByCloud;
  }
  get cloudAnswerRequested(): boolean {
    return this.props.cloudAnswerRequested;
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
