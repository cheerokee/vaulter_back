import { DomainValidationError } from '../../shared/domain/errors.js';
import type {
  HubSyncReader,
  SyncBatch,
  SyncItem,
  SyncItemType,
} from './ports/hub-sync-reader.js';
import {
  mergeSyncPage,
  SYNC_MAX_LIMIT,
  SyncHubUseCase,
} from './sync-hub.use-case.js';

const HUB_ID = '019a0000-0000-7000-8000-0000000000aa';

const item = (
  type: SyncItemType,
  syncVersion: number,
  id = `${type}-${syncVersion}`,
  deleted = false,
): SyncItem => ({
  type,
  syncVersion: BigInt(syncVersion),
  deleted,
  data: { id },
});
const batch = (items: SyncItem[], truncated = false): SyncBatch => ({
  items,
  truncated,
});
const versions = (items: SyncItem[]) => items.map((i) => Number(i.syncVersion));

const reader = { read: vi.fn() };
const useCase = () => new SyncHubUseCase(reader as unknown as HubSyncReader);

beforeEach(() => {
  vi.clearAllMocks();
  reader.read.mockResolvedValue([]);
});

describe('SyncHubUseCase', () => {
  it('defaults to since 0 and limit 500, and reads as the authenticated hub only', async () => {
    await expect(useCase().execute({ hubId: HUB_ID }, {})).resolves.toEqual({
      items: [],
      nextSince: 0n,
    });
    expect(SYNC_MAX_LIMIT).toBe(500);
    expect(reader.read).toHaveBeenCalledWith(HUB_ID, 0n, 500);
  });

  it.each([0, 501, 1.5, -1, Number.NaN])(
    'refuses limit %s before reading',
    async (limit) => {
      await expect(
        useCase().execute({ hubId: HUB_ID }, { limit }),
      ).rejects.toMatchObject({
        constructor: DomainValidationError,
        code: 'sync-limit-invalid',
      });
      expect(reader.read).not.toHaveBeenCalled();
    },
  );

  it('refuses a negative since before reading', async () => {
    await expect(
      useCase().execute({ hubId: HUB_ID }, { since: -1n }),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'sync-since-invalid',
    });
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('merges the batches by syncVersion and returns the last one as nextSince', async () => {
    reader.read.mockResolvedValue([
      batch([item('hub', 3)]),
      batch([item('member', 2), item('member', 7)]),
      batch([item('space', 5)]),
    ]);
    const page = await useCase().execute(
      { hubId: HUB_ID },
      { since: 1n, limit: 10 },
    );
    expect(versions(page.items)).toEqual([2, 3, 5, 7]);
    expect(page.nextSince).toBe(7n);
    expect(reader.read).toHaveBeenCalledWith(HUB_ID, 1n, 10);
  });

  it('keeps since as nextSince when there is nothing new', async () => {
    reader.read.mockResolvedValue([batch([]), batch([])]);
    await expect(
      useCase().execute({ hubId: HUB_ID }, { since: 42n }),
    ).resolves.toEqual({ items: [], nextSince: 42n });
  });
});

describe('mergeSyncPage', () => {
  it('cuts at limit', () => {
    const page = mergeSyncPage(
      [
        batch([item('member', 1), item('member', 4)]),
        batch([item('space', 2), item('space', 3)]),
      ],
      0n,
      3,
    );
    expect(versions(page.items)).toEqual([1, 2, 3]);
    expect(page.nextSince).toBe(3n);
  });

  it('a truncated batch bounds the page: items of other batches above its last version wait for the next page', () => {
    // member hit the limit at 4; there may be members at 5 and 6 that were not read
    const page = mergeSyncPage(
      [
        batch([item('member', 1), item('member', 4)], true),
        batch([item('space', 2), item('space', 6)]),
      ],
      0n,
      2,
    );
    expect(versions(page.items)).toEqual([1, 2]);
    const next = mergeSyncPage(
      [
        batch([item('member', 1), item('member', 4)], true),
        batch([item('space', 2), item('space', 6)]),
      ],
      0n,
      10,
    );
    expect(versions(next.items)).toEqual([1, 2, 4]);
    expect(next.nextSince).toBe(4n);
  });

  it('never splits items that share a syncVersion (one user row behind members of two organizations)', () => {
    const tie = [item('member', 5, 'org-a'), item('member', 5, 'org-b')];
    const page = mergeSyncPage(
      [
        batch([item('hub', 1), item('space', 2)]),
        batch([tie[0]!]),
        batch([tie[1]!]),
      ],
      0n,
      3,
    );
    // cutting at 3 would split the tie at 5: the page stops before it
    expect(versions(page.items)).toEqual([1, 2]);
    expect(page.nextSince).toBe(2n);
  });

  it('returns the whole tie group when it alone is larger than limit (the only case a page exceeds limit)', () => {
    const page = mergeSyncPage(
      [
        batch([item('member', 5, 'org-a')]),
        batch([item('member', 5, 'org-b')]),
        batch([item('role_assignment', 5, 'role')]),
        batch([item('space', 9)]),
      ],
      0n,
      1,
    );
    expect(page.items.map((i) => i.data.id)).toEqual([
      'org-a',
      'org-b',
      'role',
    ]);
    expect(page.nextSince).toBe(5n);
  });

  it('orders a tie deterministically by type, then by data', () => {
    const page = mergeSyncPage(
      [
        batch([item('role_assignment', 5, 'r')]),
        batch([item('member', 5, 'm-b')]),
        batch([item('member', 5, 'm-a')]),
      ],
      0n,
      10,
    );
    expect(page.items.map((i) => i.data.id)).toEqual(['m-a', 'm-b', 'r']);
  });

  it('paging by nextSince over a dataset with ties never loses nor repeats an item, for any limit', () => {
    // Dataset: per-batch unique versions (as the reader guarantees), ties only ACROSS batches.
    const all: SyncItem[][] = [
      [1, 4, 9, 10, 15, 20].map((v) => item('member', v, `a${v}`)),
      [4, 7, 15, 16].map((v) => item('member', v, `b${v}`)),
      [2, 3, 15, 18, 21].map((v) => item('role_assignment', v)),
      [5, 6, 8, 11, 12, 13, 14].map((v) => item('space_key_grant', v)),
      [17].map((v) => item('hub', v)),
    ];
    const read = (since: bigint, limit: number): SyncBatch[] =>
      all.map((rows) => {
        const after = rows.filter((r) => r.syncVersion > since);
        return batch(after.slice(0, limit), after.length >= limit);
      });
    const expected = mergeSyncPage(read(0n, 1000), 0n, 1000).items;
    expect(expected).toHaveLength(all.flat().length);
    for (let limit = 1; limit <= 12; limit++) {
      const got: SyncItem[] = [];
      let since = 0n;
      for (let guard = 0; guard < 100; guard++) {
        const page = mergeSyncPage(read(since, limit), since, limit);
        if (page.items.length === 0) break;
        got.push(...page.items);
        expect(page.nextSince > since).toBe(true);
        since = page.nextSince;
      }
      expect(got).toEqual(expected);
    }
  });
});
