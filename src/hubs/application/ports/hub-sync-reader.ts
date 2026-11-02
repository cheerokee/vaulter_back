/** What a hub downloads in a sync (decision 9 of the hubs plan). */
export const SYNC_ITEM_TYPES = [
  'hub',
  'hub_organization',
  'organization',
  'member',
  'role_assignment',
  'space',
  'space_key',
  'space_key_grant',
  'hub_space',
] as const;

export type SyncItemType = (typeof SYNC_ITEM_TYPES)[number];

/**
 * One row of the hub's local model. `syncVersion` comes from the global `sync_version_seq`; `deleted` is a tombstone
 * (then `data` carries only the item's key fields). `data` is camelCase and never carries `authHash`, a kit copy or
 * another hub's copy.
 */
export type SyncItem = {
  type: SyncItemType;
  syncVersion: bigint;
  deleted: boolean;
  data: Record<string, unknown>;
};

/**
 * The result of ONE query (one type, or one type of one organization): items with `syncVersion > since`, ascending,
 * at most `limit`, each `syncVersion` at most once inside the batch. `truncated` = the query hit `limit`, so rows
 * above its last `syncVersion` may exist.
 */
export type SyncBatch = { items: SyncItem[]; truncated: boolean };

/**
 * Read model of everything a hub may see, one batch per type (and per approved organization). Implementations read
 * all batches in ONE snapshot and derive the approved organizations themselves, from `hub_organization` under the
 * hub's own RLS context; the caller never supplies them.
 */
export abstract class HubSyncReader {
  abstract read(
    hubId: string,
    since: bigint,
    limit: number,
  ): Promise<SyncBatch[]>;
}
