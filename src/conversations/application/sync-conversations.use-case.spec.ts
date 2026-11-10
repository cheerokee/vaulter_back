import type { HubDirectory } from '../../hubs/application/hub-directory.js';
import type { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { DomainValidationError } from '../../shared/domain/errors.js';
import {
  CONVERSATION_LONG_POLL_DEGRADED_REREAD_MS,
  CONVERSATION_LONG_POLL_HELD_BACK_REREAD_MS,
  CONVERSATION_LONG_POLLS_PER_HUB,
} from '../domain/conversation-limits.js';
import { LongPollSlots } from './long-poll-slots.js';
import type {
  ConversationChangeSignal,
  ConversationChangeSubscription,
} from './ports/conversation-change-signal.js';
import type {
  ConversationChangesQuery,
  ConversationChangesReader,
  ConversationSyncItem,
} from './ports/conversation-changes-reader.js';
import { SyncConversationsUseCase } from './sync-conversations.use-case.js';

const USER = '019a0000-0000-7000-8000-0000000000a1';
const HUB = '019a0000-0000-7000-8000-0000000000b1';
const ORG = '019a0000-0000-7000-8000-0000000000c1';

const message = (sv: number): ConversationSyncItem => ({
  type: 'conversation_message',
  syncVersion: BigInt(sv),
  deleted: false,
  data: { id: `m${sv}` },
});

const events: string[] = [];
let pages: ConversationSyncItem[][];
/** The safe horizon of each read, in order (null = everything read is safe). */
let heldBack: (bigint | null)[];
const reader = {
  read: vi.fn(async (q: ConversationChangesQuery) => {
    events.push('read');
    const organizationIds = await q.organizationIds();
    const items = pages.shift() ?? [];
    return {
      organizationIds,
      batches: [{ items, truncated: false }],
      heldBackFrom: heldBack.shift() ?? null,
    };
  }),
};

type FakeSub = ConversationChangeSubscription & {
  next: ReturnType<typeof vi.fn>;
};
let live = true;
let wakes: boolean[];
const subs: FakeSub[] = [];
const signal = {
  subscribe: vi.fn(async (): Promise<ConversationChangeSubscription> => {
    events.push('subscribe');
    const sub: FakeSub = {
      live,
      next: vi.fn(async (ms: number, abort?: AbortSignal) => {
        events.push(`next:${ms}`);
        const woke = wakes.shift() ?? false;
        // Time passes while waiting: all of it on a timeout, a little on a wake.
        vi.setSystemTime(Date.now() + (woke ? 10 : ms));
        return woke && !abort?.aborted ? 'changed' : 'timeout';
      }),
      close: vi.fn(() => events.push('close')),
    };
    subs.push(sub);
    return sub;
  }),
};
const organizations = { organizationIdsOf: vi.fn(async () => [ORG]) };
const hubs = { approvedOrganizationIds: vi.fn(async () => [ORG]) };
let slots: LongPollSlots;

const useCase = () =>
  new SyncConversationsUseCase(
    reader as unknown as ConversationChangesReader,
    signal as unknown as ConversationChangeSignal,
    slots,
    organizations as unknown as OrganizationDirectory,
    hubs as unknown as HubDirectory,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
  events.length = 0;
  subs.length = 0;
  pages = [];
  heldBack = [];
  wakes = [];
  live = true;
  slots = new LongPollSlots();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SyncConversationsUseCase (person feed)', () => {
  it('reads as the person, over the organizations of the person, and merges the page', async () => {
    pages = [[message(7), message(9)]];
    const page = await useCase().byUser({ userId: USER }, { since: 5n });
    expect(page).toEqual({
      organizationIds: [ORG],
      items: [message(7), message(9)],
      nextSince: 9n,
    });
    const q = reader.read.mock.calls[0]![0];
    expect(q).toMatchObject({
      reader: { kind: 'user', userId: USER },
      since: 5n,
      limit: 500,
      conversationId: null,
    });
    expect(organizations.organizationIdsOf).toHaveBeenCalledWith(USER);
    expect(hubs.approvedOrganizationIds).not.toHaveBeenCalled();
  });

  it('safe horizon: nothing at or above a version still possibly in flight is served, and the cursor stays below it', async () => {
    pages = [[message(7), message(9), message(12)]];
    heldBack = [9n];
    const page = await useCase().byUser({ userId: USER }, { since: 5n });
    expect(page.items).toEqual([message(7)]);
    expect(page.nextSince).toBe(7n);
  });

  it('safe horizon at the first row: an empty page that keeps the cursor', async () => {
    pages = [[message(9)]];
    heldBack = [9n];
    await expect(
      useCase().byUser({ userId: USER }, { since: 5n }),
    ).resolves.toMatchObject({ items: [], nextSince: 5n });
  });

  it('an empty page keeps the cursor', async () => {
    await expect(
      useCase().byUser({ userId: USER }, { since: 42n }),
    ).resolves.toMatchObject({ items: [], nextSince: 42n });
  });

  it.each([0, 501, 1.5])('refuses limit %s before reading', async (limit) => {
    await expect(
      useCase().byUser({ userId: USER }, { limit }),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'sync-limit-invalid',
    });
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('refuses a negative cursor', async () => {
    await expect(
      useCase().byUser({ userId: USER }, { since: -1n }),
    ).rejects.toMatchObject({ code: 'sync-since-invalid' });
  });

  it('passes the conversation filter (backfill)', async () => {
    const id = '019a0000-0000-7000-8000-0000000000d1';
    await useCase().byUser({ userId: USER }, { conversationId: id });
    expect(reader.read.mock.calls[0]![0].conversationId).toBe(id);
  });
});

describe('SyncConversationsUseCase (executor feed, long poll)', () => {
  it('reads as the hub over its approved organizations; wait 0 never subscribes', async () => {
    pages = [[]];
    const page = await useCase().byHub({ hubId: HUB }, { waitSeconds: 0 });
    expect(page.items).toEqual([]);
    expect(reader.read.mock.calls[0]![0].reader).toEqual({
      kind: 'hub',
      hubId: HUB,
    });
    expect(hubs.approvedOrganizationIds).toHaveBeenCalledWith(HUB);
    expect(organizations.organizationIdsOf).not.toHaveBeenCalled();
    expect(signal.subscribe).not.toHaveBeenCalled();
  });

  it('returns at once when the first read has items (subscribed before reading)', async () => {
    pages = [[message(3)]];
    const page = await useCase().byHub({ hubId: HUB }, { waitSeconds: 25 });
    expect(page.items).toEqual([message(3)]);
    expect(events).toEqual(['subscribe', 'read', 'close']);
  });

  it('waits outside the read and re-reads on a wake, subscribing again before each read', async () => {
    pages = [[], [message(11)]];
    wakes = [true];
    const page = await useCase().byHub({ hubId: HUB }, { waitSeconds: 25 });
    expect(page).toMatchObject({ items: [message(11)], nextSince: 11n });
    expect(events).toEqual([
      'subscribe',
      'read',
      'next:25000',
      'close',
      'subscribe',
      'read',
      'close',
    ]);
  });

  it('a wake with nothing visible keeps waiting until the deadline, then answers the final re-read', async () => {
    pages = [[], [], []];
    wakes = [true, false];
    const page = await useCase().byHub(
      { hubId: HUB },
      { since: 8n, waitSeconds: 2 },
    );
    expect(page).toMatchObject({ items: [], nextSince: 8n });
    expect(reader.read).toHaveBeenCalledTimes(3);
    expect(subs.every((s) => (s.close as any).mock.calls.length === 1)).toBe(
      true,
    );
  });

  it('a missed wake still returns the change: the final re-read at the deadline sees it', async () => {
    pages = [[], [message(20)]];
    wakes = [false];
    const page = await useCase().byHub({ hubId: HUB }, { waitSeconds: 3 });
    expect(page.items).toEqual([message(20)]);
    expect(events).toContain('next:3000');
  });

  it('an empty page held back by a write in flight re-reads after a second (its commit may wake nobody)', async () => {
    pages = [[message(30)], [message(29), message(30)]];
    heldBack = [30n, null];
    wakes = [false];
    const page = await useCase().byHub({ hubId: HUB }, { waitSeconds: 25 });
    expect(events).toContain(
      `next:${CONVERSATION_LONG_POLL_HELD_BACK_REREAD_MS}`,
    );
    expect(page.items).toEqual([message(29), message(30)]);
  });

  it('without a live wake source it re-reads on a short interval', async () => {
    live = false;
    pages = [[], [message(5)]];
    await useCase().byHub({ hubId: HUB }, { waitSeconds: 25 });
    expect(events).toContain(
      `next:${CONVERSATION_LONG_POLL_DEGRADED_REREAD_MS}`,
    );
  });

  it('an aborted request stops waiting without another read and frees its slot', async () => {
    pages = [[], [message(1)]];
    const abort = new AbortController();
    signal.subscribe.mockImplementationOnce(async () => {
      events.push('subscribe');
      return {
        live: true,
        next: vi.fn(async () => {
          abort.abort();
          return 'timeout' as const;
        }),
        close: vi.fn(),
      };
    });
    const page = await useCase().byHub(
      { hubId: HUB },
      { waitSeconds: 25 },
      abort.signal,
    );
    expect(page.items).toEqual([]);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(slots.inUse(HUB)).toBe(0);
  });

  it('stops on shutdown with what it read', async () => {
    pages = [[], [message(1)]];
    signal.subscribe.mockImplementationOnce(async () => ({
      live: true,
      next: vi.fn(async () => 'closed' as const),
      close: vi.fn(),
    }));
    const page = await useCase().byHub({ hubId: HUB }, { waitSeconds: 25 });
    expect(page.items).toEqual([]);
    expect(reader.read).toHaveBeenCalledTimes(1);
  });

  it('over the per-hub cap the request does not wait (and the slots are released afterwards)', async () => {
    const held = Array.from({ length: CONVERSATION_LONG_POLLS_PER_HUB }, () =>
      slots.tryAcquire(HUB),
    );
    expect(held.every(Boolean)).toBe(true);
    pages = [[]];
    await useCase().byHub({ hubId: HUB }, { waitSeconds: 25 });
    expect(signal.subscribe).not.toHaveBeenCalled();
    expect(reader.read).toHaveBeenCalledTimes(1);
    for (const release of held) release!();
    expect(slots.inUse(HUB)).toBe(0);
  });

  it('releases the slot when the read fails', async () => {
    reader.read.mockRejectedValueOnce(new Error('boom'));
    await expect(
      useCase().byHub({ hubId: HUB }, { waitSeconds: 25 }),
    ).rejects.toThrow('boom');
    expect(slots.inUse(HUB)).toBe(0);
    expect(events.at(-1)).toBe('close');
  });

  it.each([-1, 26, 1.5])('refuses wait %s', async (waitSeconds) => {
    await expect(
      useCase().byHub({ hubId: HUB }, { waitSeconds }),
    ).rejects.toMatchObject({ code: 'sync-wait-invalid' });
  });
});

describe('LongPollSlots', () => {
  it('caps per hub and in total; release is idempotent', () => {
    const s = LongPollSlots.withCaps(2, 3);
    const a = s.tryAcquire('h1')!;
    const b = s.tryAcquire('h1')!;
    expect(s.tryAcquire('h1')).toBeNull();
    const c = s.tryAcquire('h2')!;
    expect(s.tryAcquire('h3')).toBeNull();
    a();
    a();
    expect(s.inUse('h1')).toBe(1);
    expect(s.tryAcquire('h3')).not.toBeNull();
    b();
    c();
  });
});
