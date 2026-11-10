import { Injectable } from '@nestjs/common';
import { DomainValidationError } from '../../shared/domain/errors.js';
import { mergeSyncBatches } from '../../shared/domain/sync-page.js';
import type { HubAuthContext } from './authenticate-hub-token.use-case.js';
import {
  HubSyncReader,
  SYNC_ITEM_TYPES,
  type SyncBatch,
  type SyncItem,
} from './ports/hub-sync-reader.js';

export const SYNC_MAX_LIMIT = 500;

export type SyncPage = { items: SyncItem[]; nextSince: bigint };

/**
 * Merges the reader's batches into one page (the shared `mergeSyncBatches`, in `SYNC_ITEM_TYPES` order).
 * - Horizon: a truncated batch only proves completeness up to its last `syncVersion`; items of other batches above
 *   the lowest such horizon are held back for the next page (otherwise `nextSince` would jump over unread rows).
 * - Ties: `sync_version` is one global sequence, so two rows never share a value, but one row can feed several items
 *   (a `users` row is behind the `member` item of each organization; a role row is behind its `role_assignment` item
 *   and the `member` items that embed the role). A page never splits such a group: it stops before it, or, when the
 *   group alone is larger than `limit`, returns the whole group (the only case a page exceeds `limit`; a group is at
 *   most "approved organizations + 1" items).
 * - `nextSince` = the last item's `syncVersion`, or `since` when the page is empty.
 */
export function mergeSyncPage(
  batches: SyncBatch[],
  since: bigint,
  limit: number,
): SyncPage {
  return mergeSyncBatches(batches, since, limit, SYNC_ITEM_TYPES);
}

/**
 * `GET /hub/sync` (spec hubs §4.9, plan decision 9): what an authenticated hub needs to work offline, in
 * `sync_version` order, tombstones included. Page: `since` (default 0) and `limit` (1..500, default 500).
 *
 * Scope (derived by the reader from the hub's own `hub_organization` rows, never from the caller):
 * - `hub`: the hub itself;
 * - `hub_organization`: all its links; only an approved, live link is live. Every other status (revoked, and also
 *   pending/rejected: a new request after an unlink reuses the revoked row) is a tombstone, so an exit always reaches
 *   the hub;
 * - `organization`, `member` (per organization and user: name, email, public key and the LOCKED key material,
 *   never `authHash`; plus the live organization roles and the effective hub role, `hub_user` when there is no
 *   explicit row), `role_assignment` (organization scope, space scope of the hub's spaces, hub scope of this hub,
 *   for people and for this hub's Room only): only organizations with an approved link;
 * - `space`, `space_key` (no kit copy) and `space_key_grant` (people and THIS hub only; never another hub's copy):
 *   only spaces in this hub's live `hub_space`;
 * - `hub_space`: this hub's rows of approved links.
 *
 * Tombstones carry only the key fields. LOCAL CASCADE CONTRACT (the hub must apply it; the server stops sending
 * rows that left the scope, so their own tombstones never arrive):
 * - `hub_organization` tombstone (link revoked): delete locally the organization, its members, every
 *   `role_assignment` with that `organizationId`, its spaces with their keys and grants, and its `hub_space` rows.
 *   Hub-scope roles of people left without any linked organization arrive as their own tombstones;
 * - `hub_space` tombstone (space removed from the hub): delete locally that space, its keys, its grants and its
 *   space-scope roles;
 * - FULL SYNC (`since=0`) REPLACES the hub's local state: the hub builds the new state from the full pass and drops
 *   everything it held that the pass did not bring (rows that left the scope earlier never come back as tombstones);
 * - SCOPE ENTRY (incremental passes only, `since > 0`): rows that enter the scope keep their old `syncVersion` (an
 *   organization approved again, or a space added to the hub, already had its spaces/keys/grants/members). So when an
 *   incremental page brings a live `hub_organization` or a live `hub_space` the hub did not hold live, the hub
 *   finishes the pass and then runs a full sync. The first `since=0` pass never triggers this rule.
 */
@Injectable()
export class SyncHubUseCase {
  constructor(private readonly reader: HubSyncReader) {}

  async execute(
    hub: HubAuthContext,
    input: { since?: bigint; limit?: number },
  ): Promise<SyncPage> {
    const since = input.since ?? 0n;
    const limit = input.limit ?? SYNC_MAX_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > SYNC_MAX_LIMIT) {
      throw new DomainValidationError(
        'sync-limit-invalid',
        `The sync limit must be an integer from 1 to ${SYNC_MAX_LIMIT}.`,
      );
    }
    if (since < 0n) {
      throw new DomainValidationError(
        'sync-since-invalid',
        'The sync cursor must be a non-negative integer.',
      );
    }
    const batches = await this.reader.read(hub.hubId, since, limit);
    return mergeSyncPage(batches, since, limit);
  }
}
