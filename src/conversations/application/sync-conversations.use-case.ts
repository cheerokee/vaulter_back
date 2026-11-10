import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { DomainValidationError } from '../../shared/domain/errors.js';
import { mergeSyncBatches } from '../../shared/domain/sync-page.js';
import {
  CONVERSATION_LONG_POLL_DEGRADED_REREAD_MS,
  CONVERSATION_LONG_POLL_MAX_SECONDS,
  CONVERSATION_SYNC_MAX_LIMIT,
} from '../domain/conversation-limits.js';
import { LongPollSlots } from './long-poll-slots.js';
import { ConversationChangeSignal } from './ports/conversation-change-signal.js';
import {
  CONVERSATION_ITEM_TYPES,
  ConversationChangesReader,
  type ConversationFeedReader,
  type ConversationSyncItem,
} from './ports/conversation-changes-reader.js';

export type ConversationChangesInput = {
  since?: bigint;
  limit?: number;
  conversationId?: string | null;
};

export type ConversationChangesPage = {
  /** The organizations this page covered: the client drops what it holds of any other organization. */
  organizationIds: string[];
  items: ConversationSyncItem[];
  nextSince: bigint;
};

/**
 * The conversation feeds (spec conversations §4.6), the hub sync pattern (`mergeSyncBatches`, one REPEATABLE READ
 * snapshot per page, tombstones with key fields only, `nextSince` = last item's version):
 * - PERSON (`GET /conversations/changes`): the conversations the person participates in, across the organizations
 *   where the person is an active member: `conversation`, every `conversation_participant`, the person's OWN
 *   `conversation_key_grant` rows (every version; never another person's or a hub's copy), `conversation_message`
 *   (with the encrypted body) and `conversation_attachment` (metadata). After leaving, the person still receives the
 *   tombstones of their own participation and copies (RLS: own rows), and nothing else of that conversation. A session
 *   opened through a Hub (`POST /hub/user-sessions`) gets only the conversations THAT Hub executes, and none of the
 *   own-row tombstones of others (its client drops a conversation when the Hub's own executor feed says the Hub lost
 *   it, or the conversation item stops being live).
 * - EXECUTOR (`GET /hub/conversations/changes`): the same for the conversations where the hub is executor, only in
 *   organizations with an approved, live link (the RLS executor policy has no link condition: the reader filters),
 *   with the hub's OWN copies; after losing the role (executor change, unlink, deregister, space removed, owner left)
 *   the hub receives the tombstones of its own copies. Optional long poll: `wait` seconds (≤ 25).
 *
 * CLIENT CONTRACT (both feeds; documented in CLAUDE.md, hub-lifecycle.md and pendencias-do-app.md):
 * - own `conversation_participant` tombstone (person) / own `conversation_key_grant` tombstone (hub; a hub's copies are
 *   only tombstoned when it stops being executor) = drop that conversation locally with its messages, attachments and
 *   keys; a `conversation` tombstone = the same;
 * - an organization missing from `organizationIds` = drop its conversations (left the organization / link not
 *   approved: their tombstones never come);
 * - SCOPE ENTRY: a live conversation the client does not hold (shared with the person, the hub made executor again)
 *   keeps its history at old versions: the client backfills it with `conversationId=<id>&since=0` pages, then carries on
 *   with its main cursor (items are idempotent by id and `syncVersion`);
 * - FULL SYNC (`since=0`) replaces the local state.
 *
 * COMMIT ORDER (no "commit order × sync_version" skip, unlike the hub sync): the versions of these tables are assigned
 * AT COMMIT, in commit order (migration ConversationFeedCommitOrder; `addCommitOrderedSyncVersion`), so a snapshot that
 * sees version V sees every committed row with a version <= V and `nextSince` never passes a version that can still
 * commit. Nothing is held back: a committed change is readable at once, whatever else runs in the database.
 *
 * LONG POLL (executor only): never inside a transaction or holding a pool connection while waiting. Loop: subscribe
 * to the wake source (one LISTEN connection per process), read a page in a short snapshot transaction, and if it is
 * empty wait outside any unit of work until a wake, the deadline or the client going away; then subscribe and read
 * again. The response is always a fresh read by `sync_version`, so a missed wake only delays a change until the next
 * re-read (at the deadline, or every few seconds without the LISTEN connection). Caps per Hub and per instance
 * (`LongPollSlots`): over them the request answers at once without waiting.
 */
@Injectable()
export class SyncConversationsUseCase {
  constructor(
    private readonly reader: ConversationChangesReader,
    private readonly signal: ConversationChangeSignal,
    private readonly slots: LongPollSlots,
    private readonly organizations: OrganizationDirectory,
    private readonly hubs: HubDirectory,
  ) {}

  async byUser(
    actor: Pick<Actor, 'userId' | 'hubId'>,
    input: ConversationChangesInput,
  ): Promise<ConversationChangesPage> {
    const page = pageInput(input);
    const reader: ConversationFeedReader = {
      kind: 'user',
      userId: actor.userId,
      sessionHubId: actor.hubId ?? null,
    };
    return (await this.read(reader, page)).page;
  }

  async byHub(
    hub: HubAuthContext,
    input: ConversationChangesInput & { waitSeconds?: number },
    abort?: AbortSignal,
  ): Promise<ConversationChangesPage> {
    const page = pageInput(input);
    const waitSeconds = input.waitSeconds ?? 0;
    if (
      !Number.isInteger(waitSeconds) ||
      waitSeconds < 0 ||
      waitSeconds > CONVERSATION_LONG_POLL_MAX_SECONDS
    ) {
      throw new DomainValidationError(
        'sync-wait-invalid',
        `The wait must be an integer from 0 to ${CONVERSATION_LONG_POLL_MAX_SECONDS} seconds.`,
      );
    }
    const reader: ConversationFeedReader = { kind: 'hub', hubId: hub.hubId };
    const release = waitSeconds > 0 ? this.slots.tryAcquire(hub.hubId) : null;
    if (!release) return (await this.read(reader, page)).page;

    try {
      const deadline = Date.now() + waitSeconds * 1000;
      for (;;) {
        const sub = await this.signal.subscribe(hub.hubId);
        try {
          const result = await this.read(reader, page);
          const remaining = deadline - Date.now();
          if (result.items.length > 0 || remaining <= 0 || abort?.aborted) {
            return result.page;
          }
          const slice = sub.live
            ? remaining
            : Math.min(remaining, CONVERSATION_LONG_POLL_DEGRADED_REREAD_MS);
          const outcome = await sub.next(slice, abort);
          // The client went away (nobody reads another page) or the API is shutting down.
          if (abort?.aborted || outcome === 'closed') return result.page;
        } finally {
          sub.close();
        }
      }
    } finally {
      release();
    }
  }

  private async read(
    reader: ConversationFeedReader,
    input: Required<ConversationChangesInput>,
  ): Promise<{
    page: ConversationChangesPage;
    items: ConversationSyncItem[];
  }> {
    const { organizationIds, batches } = await this.reader.read({
      reader,
      organizationIds: () =>
        reader.kind === 'user'
          ? this.organizations.organizationIdsOf(reader.userId)
          : this.hubs.approvedOrganizationIds(reader.hubId),
      since: input.since,
      limit: input.limit,
      conversationId: input.conversationId,
    });
    const merged = mergeSyncBatches(
      batches,
      input.since,
      input.limit,
      CONVERSATION_ITEM_TYPES,
    );
    return {
      page: { organizationIds, ...merged },
      items: merged.items,
    };
  }
}

function pageInput(
  input: ConversationChangesInput,
): Required<ConversationChangesInput> {
  const since = input.since ?? 0n;
  const limit = input.limit ?? CONVERSATION_SYNC_MAX_LIMIT;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > CONVERSATION_SYNC_MAX_LIMIT
  ) {
    throw new DomainValidationError(
      'sync-limit-invalid',
      `The sync limit must be an integer from 1 to ${CONVERSATION_SYNC_MAX_LIMIT}.`,
    );
  }
  if (since < 0n) {
    throw new DomainValidationError(
      'sync-since-invalid',
      'The sync cursor must be a non-negative integer.',
    );
  }
  return { since, limit, conversationId: input.conversationId ?? null };
}
