/**
 * Background jobs (pg-boss, `src/shared/infra/jobs`). A port in `shared/application` so any module can enqueue and
 * consume without importing infra.
 *
 * **Payloads carry only ids:** every value is a UUID or a safe integer (e.g. a key version). Job rows live in the
 * database without RLS and outlive the request, so a legible value (text, name, prompt, key) never goes there; the
 * handler re-reads what it needs, under its own authorization and locks. `send` rejects anything else.
 *
 * **Transactions:** called inside a `UnitOfWork.run`, `send` and `cancelQueued` join that transaction (same
 * connection): the job exists only if the transaction commits, and a cancellation is undone with it. Outside a
 * unit of work they autocommit.
 *
 * **At least once:** a handler can run more than once (retry after an error, a worker that died mid-job, the job
 * expiring while active), so it must be idempotent and must re-check, under lock, that its work still applies.
 */
export type JobPayload = Readonly<Record<string, string | number>>;

export interface JobSendOptions {
  /** The job becomes available this many seconds from now (e.g. the cloud fallback 30 s after a message). */
  startAfterSeconds?: number;
  /**
   * Deduplication: while a job of this queue with this key is waiting (not started), sending again with the same
   * key does not add a second job; it replaces the waiting job's payload and start time instead (debounce). A job
   * already running does not block a new one (on a keyed queue the new one waits until it ends).
   */
  singletonKey?: string;
}

export interface JobWorkOptions {
  /**
   * A KEYED queue: every job carries a `singletonKey`, and per key there is at most ONE waiting job and at most ONE
   * running job, across every instance (a waiting job of a key is not fetched while another job of that key runs).
   * `send` / `sendMany` without a key on it are a programming error. pg-boss `stately` policy (fixed when the queue is
   * created: a queue that already exists with another policy fails the boot, and a migration changes it).
   */
  oneJobPerKey?: boolean;
}

export interface JobContext {
  readonly id: string;
  /** 0 on the first attempt. */
  readonly retryCount: number;
  /** No retry follows if this attempt fails (retries exhausted): a handler that holds something gives it back. */
  readonly lastAttempt: boolean;
  /** Aborted when the job expires or the worker stops: long handlers should stop early. */
  readonly signal: AbortSignal;
}

export type JobHandler<P extends JobPayload> = (
  payload: P,
  job: JobContext,
) => Promise<void>;

export abstract class JobQueue {
  /** Enqueues a job; returns its id (`null` only if the queue refused it). */
  abstract send<P extends JobPayload>(
    name: string,
    payload: P,
    options?: JobSendOptions,
  ): Promise<string | null>;

  /**
   * Enqueues many jobs of one queue (in the unit of work, like `send`). Keyed queues (`oneJobPerKey`) only: a key that
   * already has a waiting job gets no second one; the waiting job keeps its payload and moves to the EARLIER of its
   * start and this one's (so a later message never postpones an earlier one). Returns how many were added. On a queue
   * that is not keyed, `singletonKey` is refused (pg-boss's standard queues do not deduplicate inserts).
   */
  abstract sendMany<P extends JobPayload>(
    name: string,
    jobs: readonly {
      payload: P;
      singletonKey?: string;
      startAfterSeconds?: number;
    }[],
  ): Promise<number>;

  /**
   * Registers the handler of a queue (and how the queue is created: `options.oneJobPerKey`). Without workers in this
   * process (`JOB_WORKERS_ENABLED=false`, the e2e default) the registration is kept but nothing is fetched. One handler
   * per queue per process; call it in `onModuleInit`, before anything sends to the queue.
   */
  abstract work<P extends JobPayload>(
    name: string,
    handler: JobHandler<P>,
    options?: JobWorkOptions,
  ): Promise<void>;

  /**
   * Deletes the jobs of a queue that are still waiting (created or waiting for a retry) and whose payload contains
   * every field of `match` (e.g. `{ spaceId }`). A job already running is not touched: its handler must re-check
   * that its work still applies. Returns how many were deleted.
   */
  abstract cancelQueued(name: string, match: JobPayload): Promise<number>;
}

const QUEUE_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const PAYLOAD_KEY = /^[a-z][A-Za-z0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SINGLETON_KEY = /^[A-Za-z0-9:._-]{1,200}$/;

/** Queue names: lowercase words joined by `.` or `-` (e.g. `cloud.index-object`). */
export function assertQueueName(name: string): string {
  if (typeof name !== 'string' || !QUEUE_NAME.test(name)) {
    throw new Error(`job queue name is invalid: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Only ids: UUIDs (lowercase) or safe integers, under camelCase keys. A programming error otherwise. */
export function assertIdsOnlyPayload(payload: unknown): JobPayload {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype
  ) {
    throw new Error('job payload must be a plain object of ids');
  }
  for (const [key, value] of Object.entries(payload)) {
    const ok =
      PAYLOAD_KEY.test(key) &&
      ((typeof value === 'string' && UUID.test(value)) ||
        (typeof value === 'number' && Number.isSafeInteger(value)));
    // The value is never echoed: it is exactly what must not leak.
    if (!ok) {
      throw new Error(
        `job payload field ${JSON.stringify(key)} must be a UUID or a safe integer`,
      );
    }
  }
  return payload as JobPayload;
}

export function assertSendOptions(options: JobSendOptions): JobSendOptions {
  const { startAfterSeconds, singletonKey } = options;
  if (
    startAfterSeconds !== undefined &&
    (!Number.isSafeInteger(startAfterSeconds) || startAfterSeconds < 0)
  ) {
    throw new Error('startAfterSeconds must be a non-negative integer');
  }
  if (singletonKey !== undefined && !SINGLETON_KEY.test(singletonKey)) {
    throw new Error('singletonKey must be 1..200 chars of [A-Za-z0-9:._-]');
  }
  return options;
}
