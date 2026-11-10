import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import pg from 'pg';
import { DataSource } from 'typeorm';
import {
  ConversationChangeSignal,
  type ChangeWait,
  type ConversationChangeSubscription,
} from '../../application/ports/conversation-change-signal.js';

/** Channel of the NOTIFY triggers (migration ConversationChangeNotify); the payload is the hub id. */
export const CONVERSATION_CHANGES_CHANNEL = 'conversation_changes';
/** How long a subscribe waits for the LISTEN connection before going on degraded (short re-reads). */
const CONNECT_WAIT_MS = 2_000;
/** After a failed or lost LISTEN connection, the next attempt waits at least this long. */
const RECONNECT_BACKOFF_MS = 5_000;

class Waiter {
  private pending: ChangeWait | null = null;
  private resolve: ((outcome: ChangeWait) => void) | null = null;

  /** `changed` (a NOTIFY or a re-read hint) or `closed` (shutdown, sticky). */
  wake(outcome: 'changed' | 'closed' = 'changed'): void {
    if (this.pending !== 'closed') this.pending = outcome;
    this.resolve?.(this.pending);
  }

  next(timeoutMs: number, abort?: AbortSignal): Promise<ChangeWait> {
    if (this.pending) return Promise.resolve(this.take());
    if (abort?.aborted || timeoutMs <= 0) return Promise.resolve('timeout');
    return new Promise<ChangeWait>((resolve) => {
      const timer = setTimeout(() => this.resolve?.('timeout'), timeoutMs);
      const onAbort = () => this.resolve?.('timeout');
      abort?.addEventListener('abort', onAbort, { once: true });
      this.resolve = (outcome) => {
        clearTimeout(timer);
        abort?.removeEventListener('abort', onAbort);
        this.resolve = null;
        if (outcome !== 'timeout') this.take();
        resolve(outcome);
      };
    });
  }

  private take(): ChangeWait {
    const outcome = this.pending ?? 'timeout';
    if (outcome !== 'closed') this.pending = null;
    return outcome;
  }
}

/**
 * Wake source of the executor long poll: ONE dedicated LISTEN connection per process (outside the TypeORM pool, with
 * the runtime login), opened on the first long poll, fanned out in memory to the waiting requests of each hub. A
 * waiting request holds no pool connection and no transaction.
 * - Lost connection (error/end): every waiter is woken (they re-read: notifications may have been missed) and new
 *   subscriptions are degraded (`live: false`, short re-reads) until a reconnect succeeds; reconnects are lazy (the next
 *   subscribe) with a backoff. A reconnect wakes everybody again for the same reason.
 * - Shutdown: wakes everyone (their request answers its last read) and closes the connection.
 */
@Injectable()
export class PgConversationChangeSignal
  extends ConversationChangeSignal
  implements OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(PgConversationChangeSignal.name);
  private readonly waiters = new Map<string, Set<Waiter>>();
  private client: pg.Client | null = null;
  private listening = false;
  private connecting: Promise<void> | null = null;
  private retryAt = 0;
  private closed = false;

  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async subscribe(hubId: string): Promise<ConversationChangeSubscription> {
    await this.ensureListening();
    const waiter = new Waiter();
    let set = this.waiters.get(hubId);
    if (!set) {
      set = new Set();
      this.waiters.set(hubId, set);
    }
    set.add(waiter);
    if (this.closed) waiter.wake('closed');
    return {
      live: this.listening,
      next: (timeoutMs, abort) => waiter.next(timeoutMs, abort),
      close: () => {
        const current = this.waiters.get(hubId);
        current?.delete(waiter);
        if (current?.size === 0) this.waiters.delete(hubId);
      },
    };
  }

  /** Wakes the waiting long polls of one hub (a NOTIFY). Public: the e2e drops it to simulate a missed NOTIFY. */
  dispatch(hubId: string): void {
    for (const waiter of this.waiters.get(hubId) ?? []) waiter.wake();
  }

  /** Waiters currently subscribed (all hubs). For tests and metrics. */
  waiting(): number {
    let n = 0;
    for (const set of this.waiters.values()) n += set.size;
    return n;
  }

  private wakeAll(outcome: 'changed' | 'closed' = 'changed'): void {
    for (const set of this.waiters.values()) {
      for (const waiter of set) waiter.wake(outcome);
    }
  }

  private async ensureListening(): Promise<void> {
    if (this.listening || this.closed) return;
    if (!this.connecting) {
      if (Date.now() < this.retryAt) return;
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.connecting,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CONNECT_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  private async connect(): Promise<void> {
    // The same server, database and runtime login as the pool (the TypeORM options of the app DataSource).
    const o = this.dataSource.options as {
      host?: string;
      port?: number;
      username?: string;
      password?: unknown;
      database?: string;
    };
    const client = new pg.Client({
      host: o.host,
      port: o.port,
      user: o.username,
      password: typeof o.password === 'string' ? o.password : undefined,
      database: o.database,
      connectionTimeoutMillis: CONNECT_WAIT_MS,
      application_name: 'conversation-changes-listener',
    });
    const lost = (reason: string) => {
      if (this.client !== client) return;
      this.client = null;
      this.listening = false;
      this.retryAt = Date.now() + RECONNECT_BACKOFF_MS;
      if (!this.closed) {
        this.logger.warn(
          `conversation change listener lost (${reason}); long polls degrade to short re-reads`,
        );
      }
      this.wakeAll();
      client.end().catch(() => undefined);
    };
    client.on('notification', (msg) => {
      if (msg.channel === CONVERSATION_CHANGES_CHANNEL && msg.payload) {
        this.dispatch(msg.payload);
      }
    });
    client.on('error', (err) => lost(err.message));
    client.on('end', () => lost('connection ended'));
    this.client = client;
    try {
      await client.connect();
      await client.query(`LISTEN ${CONVERSATION_CHANGES_CHANNEL}`);
      if (this.closed || this.client !== client) {
        await client.end().catch(() => undefined);
        return;
      }
      this.listening = true;
      // Anything committed while there was no LISTEN connection was never signalled: everybody re-reads.
      this.wakeAll();
    } catch (err) {
      lost(err instanceof Error ? err.message : String(err));
    }
  }

  onModuleDestroy(): void {
    this.closed = true;
    this.wakeAll('closed');
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    this.wakeAll('closed');
    const client = this.client;
    this.client = null;
    this.listening = false;
    await client?.end().catch(() => undefined);
  }
}
