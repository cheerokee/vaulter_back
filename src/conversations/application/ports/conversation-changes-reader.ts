import type {
  SyncBatchOf,
  SyncItemOf,
} from '../../../shared/domain/sync-page.js';

/** What the conversation feeds carry, in tie order (one row = one item, so ties never happen in practice). */
export const CONVERSATION_ITEM_TYPES = [
  'conversation',
  'conversation_participant',
  'conversation_key_grant',
  'conversation_message',
  'conversation_attachment',
] as const;

export type ConversationItemType = (typeof CONVERSATION_ITEM_TYPES)[number];
export type ConversationSyncItem = SyncItemOf<ConversationItemType>;
export type ConversationSyncBatch = SyncBatchOf<ConversationItemType>;

/**
 * Who reads the feed: a person (participant) or a Hub (executor). Never supplied by the request body. `sessionHubId`:
 * the person's session was opened through that Hub (from the session row): only the conversations it executes.
 */
export type ConversationFeedReader =
  | { kind: 'user'; userId: string; sessionHubId?: string | null }
  | { kind: 'hub'; hubId: string };

export type ConversationChangesQuery = {
  reader: ConversationFeedReader;
  /**
   * The organizations to read, resolved INSIDE the reader's snapshot transaction (person: active memberships; Hub:
   * approved, live links). Every other organization is out of the feed.
   */
  organizationIds: () => Promise<string[]>;
  since: bigint;
  limit: number;
  /** Only this conversation (backfill when a conversation enters the scope); null = every one in scope. */
  conversationId: string | null;
};

export type ConversationChangesRead = {
  organizationIds: string[];
  batches: ConversationSyncBatch[];
  /**
   * SAFE HORIZON: when a visible row was written by a transaction newer than one still running (whose versions,
   * invisible to this snapshot, may be lower), the bound below which every version is final; null when every row read
   * is below it. The page holds back everything at or above it, so `nextSince` never jumps over a version committed
   * later.
   */
  heldBackFrom: bigint | null;
};

/**
 * Read model of the conversation feeds: one batch per item type and organization, all in ONE snapshot
 * (REPEATABLE READ, READ ONLY), under the reader's own RLS context. Items carry only what the backend may see plus the
 * encrypted payloads (header, body, the reader's OWN key copies); never another person's or hub's copy.
 */
export abstract class ConversationChangesReader {
  abstract read(
    query: ConversationChangesQuery,
  ): Promise<ConversationChangesRead>;
}
