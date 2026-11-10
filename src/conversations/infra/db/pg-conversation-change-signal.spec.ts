import { EventEmitter } from 'node:events';
import type { DataSource } from 'typeorm';

// One fake pg.Client per connect: the spec drives its queries and events.
const clients: FakeClient[] = [];
class FakeClient extends EventEmitter {
  readonly config: Record<string, unknown>;
  ping: () => Promise<unknown> = () => Promise.resolve({ rows: [] });
  ended = false;
  constructor(config: Record<string, unknown>) {
    super();
    this.config = config;
    clients.push(this);
  }
  connect() {
    return Promise.resolve();
  }
  query(sql: string) {
    return sql === 'SELECT 1' ? this.ping() : Promise.resolve({ rows: [] });
  }
  end() {
    this.ended = true;
    return Promise.resolve();
  }
}
vi.mock('pg', () => ({ default: { Client: FakeClient } }));

const { PgConversationChangeSignal } =
  await import('./pg-conversation-change-signal.js');

describe('PgConversationChangeSignal', () => {
  const HUB = '019a0000-0000-7000-8000-0000000000aa';
  const dataSource = {
    options: { host: 'db', port: 5432, username: 'u', database: 'd' },
  } as unknown as DataSource;

  beforeEach(() => {
    clients.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the LISTEN connection with TCP keepalive', async () => {
    const signal = new PgConversationChangeSignal(dataSource);
    const sub = await signal.subscribe(HUB);
    expect(sub.live).toBe(true);
    expect(clients[0]!.config).toMatchObject({ keepAlive: true });
    await signal.onApplicationShutdown();
  });

  it('a failed ping declares the connection lost: waiters wake (spread over up to 1 s) and new subscriptions degrade', async () => {
    const signal = new PgConversationChangeSignal(dataSource);
    await signal.subscribe(HUB); // opens the connection
    const sub = await signal.subscribe(HUB);
    const woke = sub.next(60_000);
    let outcome: string | null = null;
    void woke.then((o) => {
      outcome = o;
    });

    clients[0]!.ping = () => Promise.reject(new Error('timeout'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clients[0]!.ended).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBe('changed');
    // Within the reconnect backoff: degraded (short re-reads).
    const late = signal.subscribe(HUB);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await late).live).toBe(false);
    await signal.onApplicationShutdown();
  });

  it('waking everybody after a reconnect is jittered, not instantaneous', async () => {
    const signal = new PgConversationChangeSignal(dataSource);
    await signal.subscribe(HUB);
    const subs = await Promise.all(
      Array.from({ length: 50 }, () => signal.subscribe(HUB)),
    );
    const outcomes: string[] = [];
    for (const s of subs) {
      void s.next(60_000).then((o) => outcomes.push(o));
    }
    clients[0]!.emit('end');
    await vi.advanceTimersByTimeAsync(0);
    // Not everyone at once (50 waiters, uniform 0–1 s: all at 0 ms is practically impossible).
    expect(outcomes.length).toBeLessThan(50);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcomes).toHaveLength(50);
    expect(new Set(outcomes)).toEqual(new Set(['changed']));
    await signal.onApplicationShutdown();
  });
});
