/**
 * One item of a `sync_version` feed (the hub sync, the conversation feeds). `syncVersion` comes from the global
 * `sync_version_seq` (hub sync) or from `conversation_sync_version_seq`, assigned at commit (conversation feeds);
 * `deleted` is a tombstone (then `data` carries only the item's key fields).
 */
export type SyncItemOf<T extends string> = {
  type: T;
  syncVersion: bigint;
  deleted: boolean;
  data: Record<string, unknown>;
};

/**
 * The result of ONE query: items with `syncVersion > since`, ascending, at most `limit`. `truncated` = the query hit
 * `limit`, so rows above its last `syncVersion` may exist.
 */
export type SyncBatchOf<T extends string> = {
  items: SyncItemOf<T>[];
  truncated: boolean;
};

export type SyncPageOf<T extends string> = {
  items: SyncItemOf<T>[];
  nextSince: bigint;
};

/**
 * Merges the batches of one snapshot into one page (shared by every `sync_version` feed).
 * - Horizon: a truncated batch only proves completeness up to its last `syncVersion`; items of other batches above
 *   the lowest such horizon are held back for the next page (otherwise `nextSince` would jump over unread rows).
 * - Ties: one row can feed several items (same `syncVersion`; the hub sync's `member`). A page never splits such a
 *   group: it stops before it, or, when the group alone is larger than `limit`, returns the whole group (the only case
 *   a page exceeds `limit`). The conversation feeds have no ties (one item per row, versions from a sequence).
 * - Order: `syncVersion`, then `typeOrder`, then the JSON of `data` (deterministic).
 * - `nextSince` = the last item's `syncVersion`, or `since` when the page is empty.
 */
export function mergeSyncBatches<T extends string>(
  batches: SyncBatchOf<T>[],
  since: bigint,
  limit: number,
  typeOrder: readonly T[],
): SyncPageOf<T> {
  const rank = new Map<T, number>(typeOrder.map((t, i) => [t, i]));
  const compare = (a: SyncItemOf<T>, b: SyncItemOf<T>): number => {
    if (a.syncVersion !== b.syncVersion) {
      return a.syncVersion < b.syncVersion ? -1 : 1;
    }
    const byType = (rank.get(a.type) ?? 0) - (rank.get(b.type) ?? 0);
    if (byType !== 0) return byType;
    const ka = JSON.stringify(a.data);
    const kb = JSON.stringify(b.data);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };

  let horizon: bigint | null = null;
  for (const b of batches) {
    const last = b.items.at(-1);
    if (!b.truncated || !last) continue;
    if (horizon === null || last.syncVersion < horizon) {
      horizon = last.syncVersion;
    }
  }
  const all = batches
    .flatMap((b) => b.items)
    .filter((i) => horizon === null || i.syncVersion <= horizon)
    .sort(compare);

  let end = Math.min(limit, all.length);
  if (all.length > limit) {
    const cut = all[limit - 1]!.syncVersion;
    if (all[limit]!.syncVersion === cut) {
      let start = limit - 1;
      while (start > 0 && all[start - 1]!.syncVersion === cut) start--;
      if (start > 0) {
        end = start;
      } else {
        while (end < all.length && all[end]!.syncVersion === cut) end++;
      }
    }
  }
  const items = all.slice(0, end);
  return { items, nextSince: items.at(-1)?.syncVersion ?? since };
}
