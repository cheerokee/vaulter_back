import { DomainValidationError } from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';
import type { ConversationActor } from './conversation-actor.js';
import {
  conversationKeyRotationRequired,
  conversationKeyVersionStale,
  headerTooLarge,
  notConversationOwner,
} from './conversation-errors.js';
import { MAX_HEADER_BYTES } from './conversation-limits.js';
import {
  ARCHIVED_STATE,
  assertConversationState,
  type ConversationState,
} from './conversation-state.js';
import { assertDeviceId } from './device-id.js';
import { assertEncryptedBlob } from './encrypted-blob.js';

export type ConversationProps = {
  organizationId: string;
  spaceId: string;
  createdByUserId: string;
  ownerUserId: string;
  /** Hub where the copilot works on it; null = no executor (messages wait as pending). */
  executorHubId: string | null;
  state: ConversationState;
  lastMessageAt: Date | null;
  currentKeyVersion: number;
  keyRotationRequired: boolean;
  /** Encrypted with the conversation key (title, plan...); null only after retention purged a tombstone. */
  encryptedHeader: string | null;
  headerKeyVersion: number | null;
  /** Link by id to the conversation this one was moved from (another space); never a foreign key. */
  movedFromConversationId: string | null;
  /**
   * Live participants, sorted. Read-only here: the database derives it from `conversation_participants` (trigger) and
   * row-level security uses it; the repository never writes it.
   */
  participantUserIds: readonly string[];
  createdAt?: Date;
  updatedAt?: Date | null;
  deletedAt: Date | null;
};

const headerBytes = (h: string) =>
  assertEncryptedBlob(h, MAX_HEADER_BYTES, () =>
    headerTooLarge(MAX_HEADER_BYTES),
  );

/**
 * A conversation ("assunto") of a space (spec 2026-11-09-conversations §4.1, §4.2). The backend only sees metadata:
 * ids, owner, executor, state, times and key versions; title and plan live in the encrypted header.
 * Who may do what: the owner archives/reopens, removes participants, changes the executor and moves; the executor
 * moves the work states; any participant adds people and leaves (use cases).
 */
export class Conversation extends Entity<ConversationProps> {
  static create(input: {
    id: string;
    organizationId: string;
    spaceId: string;
    createdByUserId: string;
    ownerUserId: string;
    executorHubId: string | null;
    state: ConversationState;
    encryptedHeader: string;
    movedFromConversationId?: string | null;
    now: Date;
  }): Conversation {
    const id = assertDeviceId(input.id, 'conversation-id-invalid');
    const movedFrom = input.movedFromConversationId ?? null;
    if (movedFrom === id) {
      throw new DomainValidationError(
        'conversation-moved-from-invalid',
        'A conversation cannot be moved from itself.',
      );
    }
    headerBytes(input.encryptedHeader);
    return new Conversation(
      {
        organizationId: input.organizationId,
        spaceId: input.spaceId,
        createdByUserId: input.createdByUserId,
        ownerUserId: input.ownerUserId,
        executorHubId: input.executorHubId,
        state: assertConversationState(input.state),
        lastMessageAt: null,
        currentKeyVersion: 1,
        keyRotationRequired: false,
        encryptedHeader: input.encryptedHeader,
        headerKeyVersion: 1,
        movedFromConversationId: movedFrom,
        participantUserIds: [input.ownerUserId],
        createdAt: input.now,
        deletedAt: null,
      },
      id,
    );
  }

  static restore(props: ConversationProps, id: string): Conversation {
    return new Conversation(props, id);
  }

  snapshot(): ConversationProps {
    return { ...this.props };
  }

  isOwner(userId: string): boolean {
    return this.props.ownerUserId === userId;
  }

  isExecutor(hubId: string): boolean {
    return this.props.executorHubId === hubId;
  }

  isParticipant(userId: string): boolean {
    return this.props.participantUserIds.includes(userId);
  }

  /** 403 `not-conversation-owner` for anyone but the owner (remove people, change executor, move, archive). */
  assertOwner(userId: string): void {
    if (!this.isOwner(userId)) throw notConversationOwner();
  }

  /**
   * Archiving and reopening (to or from `arquivado`) is the owner's; every other change is the executor's (the copilot
   * reports its work). Setting the current state again is a no-op.
   */
  changeState(actor: ConversationActor, next: ConversationState): void {
    const state = assertConversationState(next);
    if (state === this.props.state) return;
    const archiving =
      state === ARCHIVED_STATE || this.props.state === ARCHIVED_STATE;
    const allowed = archiving
      ? actor.kind === 'user' && this.isOwner(actor.userId)
      : actor.kind === 'hub' && this.isExecutor(actor.hubId);
    if (!allowed) throw notConversationOwner();
    this.props = { ...this.props, state };
  }

  /**
   * A new executor (eligibility is the use case's: `assertExecutorEligible`). Replacing one requires a key rotation:
   * the old Hub knew the key. Choosing the first one does not.
   */
  changeExecutor(hubId: string | null): void {
    const previous = this.props.executorHubId;
    if (previous === hubId) return;
    this.props = {
      ...this.props,
      executorHubId: hubId,
      keyRotationRequired: this.props.keyRotationRequired || previous !== null,
    };
  }

  /**
   * The executor stopped being valid (Hub deregistered, unlinked, space removed, owner left). Persist it (and tombstone
   * the Hub's key copies) in a participant's user scope, never the Hub's own: the Hub can no longer see the row.
   */
  loseExecutor(): boolean {
    if (this.props.executorHubId === null) return false;
    this.changeExecutor(null);
    return true;
  }

  /** Someone left (participant or executor): the next key version must exclude them. */
  markRotationRequired(): void {
    this.props = { ...this.props, keyRotationRequired: true };
  }

  /** New content must use the current key version, and never while a rotation is pending. */
  assertCanWrite(keyVersion: number): void {
    if (this.props.keyRotationRequired) throw conversationKeyRotationRequired();
    if (keyVersion !== this.props.currentKeyVersion) {
      throw conversationKeyVersionStale(this.props.currentKeyVersion);
    }
  }

  /** Accepts only the immediate next version; clears the pending-rotation flag. */
  completeRotation(nextVersion: number): void {
    const expected = this.props.currentKeyVersion + 1;
    if (nextVersion !== expected) throw conversationKeyVersionStale(expected);
    this.props = {
      ...this.props,
      currentKeyVersion: nextVersion,
      keyRotationRequired: false,
    };
  }

  replaceHeader(encryptedHeader: string, keyVersion: number): void {
    this.assertCanWrite(keyVersion);
    headerBytes(encryptedHeader);
    this.props = {
      ...this.props,
      encryptedHeader,
      headerKeyVersion: keyVersion,
    };
  }

  recordMessage(sentAt: Date): void {
    const last = this.props.lastMessageAt;
    if (last && last.getTime() >= sentAt.getTime()) return;
    this.props = { ...this.props, lastMessageAt: sentAt };
  }

  transferOwnership(userId: string): void {
    if (!this.isParticipant(userId)) {
      throw new DomainValidationError(
        'conversation-owner-not-participant',
        'The owner must be a participant of the conversation.',
      );
    }
    this.props = { ...this.props, ownerUserId: userId };
  }

  tombstone(now: Date): void {
    if (this.props.deletedAt) return;
    this.props = { ...this.props, deletedAt: now };
  }

  /** Retention: the encrypted header goes away; the row (id, tombstone) stays for sync. */
  purgeHeader(): void {
    if (!this.props.deletedAt) {
      throw new Error('purgeHeader: only a tombstoned conversation is purged.');
    }
    this.props = {
      ...this.props,
      encryptedHeader: null,
      headerKeyVersion: null,
    };
  }

  get organizationId(): string {
    return this.props.organizationId;
  }
  get spaceId(): string {
    return this.props.spaceId;
  }
  get createdByUserId(): string {
    return this.props.createdByUserId;
  }
  get ownerUserId(): string {
    return this.props.ownerUserId;
  }
  get executorHubId(): string | null {
    return this.props.executorHubId;
  }
  get state(): ConversationState {
    return this.props.state;
  }
  get lastMessageAt(): Date | null {
    return this.props.lastMessageAt;
  }
  get currentKeyVersion(): number {
    return this.props.currentKeyVersion;
  }
  get keyRotationRequired(): boolean {
    return this.props.keyRotationRequired;
  }
  get encryptedHeader(): string | null {
    return this.props.encryptedHeader;
  }
  get headerKeyVersion(): number | null {
    return this.props.headerKeyVersion;
  }
  get movedFromConversationId(): string | null {
    return this.props.movedFromConversationId;
  }
  get participantUserIds(): readonly string[] {
    return this.props.participantUserIds;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
  get updatedAt(): Date | null | undefined {
    return this.props.updatedAt;
  }
  get deletedAt(): Date | null {
    return this.props.deletedAt;
  }
}
