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
   * already running does not block a new one.
   */
  singletonKey?: string;
}

export interface JobContext {
  readonly id: string;
  /** 0 on the first attempt. */
  readonly retryCount: number;
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
   * Registers the handler of a queue. Without workers in this process (`JOB_WORKERS_ENABLED=false`, the e2e
   * default) the registration is kept but nothing is fetched. One handler per queue per process.
   */
  abstract work<P extends JobPayload>(
    name: string,
    handler: JobHandler<P>,
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
