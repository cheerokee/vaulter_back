import { Entity } from '../../shared/domain/entity.js';
import { sameActor, type ActorRef } from './conversation-actor.js';
import {
  messageReplacesInvalid,
  messageTooLarge,
  notConversationOwner,
} from './conversation-errors.js';
import {
  AGENT_ACK_LEASE_MS,
  MAX_MESSAGE_BYTES,
} from './conversation-limits.js';
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
  /** The person's message a `pc` hub (the agent) answers with this one; null for every other message. */
  answersMessageId?: string | null;
  /**
   * Until when the ack of a `pc` hub (the agent) holds it (`AGENT_ACK_LEASE_MS`, database clock); null for any other
   * ack and while pending. Past it, without an answer of that hub, the lease sweep requeues it.
   */
  ackedLeaseUntil?: Date | null;
  /** When it last went back to the queue (an executor that acked it stopped being the executor); null if never. */
  requeuedAt?: Date | null;
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
    /** The agent's answer (a `pc` hub's message only): the person's message it answers. */
    answersMessageId?: string | null;
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
        answersMessageId:
          input.author.kind === 'hub' ? (input.answersMessageId ?? null) : null,
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
      other.replacesMessageId === this.replacesMessageId &&
      other.answersMessageId === this.answersMessageId
    );
  }

  /**
   * The executor took it: the Hub or the cloud (reserve executor). The first ack wins (never both); returns whether this
   * call changed anything. `agentLease`: the hub is a `pc` (the agent), whose ack holds the message only for
   * `AGENT_ACK_LEASE_MS` from `now` (spec pc-agent §5.3).
   */
  ack(
    now: Date,
    by: { kind: 'hub'; hubId: string } | { kind: 'cloud' },
    options: { agentLease?: boolean } = {},
  ): boolean {
    if (!this.props.pending) return false;
    const agentLease = by.kind === 'hub' && (options.agentLease ?? false);
    this.props = {
      ...this.props,
      pending: false,
      ackedAt: now,
      ackedByHubId: by.kind === 'hub' ? by.hubId : null,
      ackedByCloud: by.kind === 'cloud',
      ackedLeaseUntil: agentLease
        ? new Date(now.getTime() + AGENT_ACK_LEASE_MS)
        : null,
    };
    return true;
  }

  /**
   * The agent's turn on this message at `now`: a live person's message acknowledged by `hubId` with a lease still
   * running. Whether the hub already answered it is the repository's to tell (`answeredAfter`).
   */
  isAgentTurnOf(hubId: string, now: Date): boolean {
    const until = this.props.ackedLeaseUntil ?? null;
    return (
      this.props.authorUserId !== null &&
      !this.props.deletedAt &&
      !this.props.pending &&
      this.props.ackedByHubId === hubId &&
      until !== null &&
      now.getTime() < until.getTime()
    );
  }

  /** Moves the agent's lease to `now` + `AGENT_ACK_LEASE_MS` (the caller checked `isAgentTurnOf`). */
  renewAgentLease(now: Date): Date {
    if (this.props.ackedByHubId === null || !this.props.ackedLeaseUntil) {
      throw new Error('renewAgentLease: only a message under an agent lease.');
    }
    const until = new Date(now.getTime() + AGENT_ACK_LEASE_MS);
    this.props = { ...this.props, ackedLeaseUntil: until };
    return until;
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
  get answersMessageId(): string | null {
    return this.props.answersMessageId ?? null;
  }
  get ackedLeaseUntil(): Date | null {
    return this.props.ackedLeaseUntil ?? null;
  }
  get requeuedAt(): Date | null {
    return this.props.requeuedAt ?? null;
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
