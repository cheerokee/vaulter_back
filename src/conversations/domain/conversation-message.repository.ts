import type { ConversationScope } from './conversation-actor.js';
import type { ConversationMessage } from './conversation-message.js';

/** A conversation with a message whose agent ack lease ran out (`listExpiredAgentLeases`). */
export type ExpiredAgentLease = {
  organizationId: string;
  conversationId: string;
  /** The `pc` hub that acknowledged it (the conversation's executor: an executor change clears the leases). */
  hubId: string;
};

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
   * no longer see the conversation). An agent's ack (under a lease) counts as answered only by its own answer
   * (`answeredBy`), never by any later message of the hub. For a Hub, every agent ack lease it holds in the
   * conversation goes too (answered messages included): a lease always belongs to the current executor, which the
   * lease sweep relies on.
   */
  abstract requeueAckedBy(
    scope: ConversationScope,
    conversationId: string,
    by: AckedBy,
  ): Promise<string[]>;
  /**
   * The lease sweep's candidates, across organizations (RLS context `app.agent_lease_sweep`, which reads only the rows
   * under a lease): up to `limit` conversations with a message whose agent ack lease ran out (database clock), in
   * (conversation, hub) order, strictly after `after` (keyset: a pass walks every candidate once, so candidates it
   * skips never hide the ones behind them). Outside or inside a unit of work; no lock.
   */
  abstract listExpiredAgentLeases(
    limit: number,
    after?: ExpiredAgentLease | null,
  ): Promise<ExpiredAgentLease[]>;
  /**
   * The agent's ack ran out (spec pc-agent §5.3): every live person's message of the conversation whose lease ended
   * (database clock, read ONCE for the whole call) and that has no answer of the agent (`answeredBy`) goes back to
   * `pending` (`requeued_at` new, ack and lease cleared), like `requeueAckedBy`; the other leases expired at that same
   * instant (answered or tombstoned messages) are just cleared, the ack untouched. Returns the requeued ids and how many
   * leases were only cleared. Inside `UnitOfWork.run`, with the conversation locked, in a PARTICIPANT's scope.
   */
  abstract requeueExpiredAgentLeases(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<{ requeued: string[]; cleared: number }>;
  /**
   * Whether the agent answered `messageId`: a hub message of the conversation with `answersMessageId` = it (tombstoned
   * or not). The answer rule of a `pc` hub; an appliance keeps `answeredAfter`.
   */
  abstract answeredBy(
    scope: ConversationScope,
    conversationId: string,
    messageId: string,
  ): Promise<boolean>;
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
   * Nulls the encrypted body of up to `limit` tombstoned messages of the conversation that still have one (its trash),
   * in id order, and tells how many are left. The usage trigger takes the bytes out of the space usage and trash.
   * Inside `UnitOfWork.run`, with the conversation locked.
   */
  abstract purgeTrash(
    scope: ConversationScope,
    conversationId: string,
    limit: number,
  ): Promise<{ messages: number; bytes: number; remaining: number }>;
}
