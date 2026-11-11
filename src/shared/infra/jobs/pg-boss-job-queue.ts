import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgBoss, type Db, type Job, type Queue } from 'pg-boss';
import { DataSource } from 'typeorm';
import {
  assertIdsOnlyPayload,
  assertQueueName,
  assertSendOptions,
  type JobHandler,
  type JobPayload,
  type JobSendOptions,
  JobQueue,
} from '../../application/job-queue.js';
import { DomainError } from '../../domain/errors.js';
import { currentManager } from '../db/unit-of-work.js';
import { JOB_QUEUE_SCHEMA } from './pg-boss-schema.js';

/**
 * Connections of the pg-boss pool of each API instance, apart from the TypeORM pool (`DB_POOL_MAX_CONNECTIONS`) and
 * the conversations LISTEN connection: count instances × (10 + 1 + this) against the database `max_connections`.
 * Workers hold a connection only to fetch and to settle a job, never while the handler runs (the handler uses the
 * TypeORM pool through its own unit of work).
 */
export const JOB_QUEUE_POOL_MAX = 4;

/** Defaults of every queue (created on first use): 3 retries with exponential backoff from 30 s, 15 min to run. */
export const JOB_QUEUE_DEFAULTS: Omit<Queue, 'name'> = {
  policy: 'standard',
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 600,
  expireInSeconds: 900,
};

/** How often an idle worker polls its queue (LISTEN/NOTIFY is off: one connection less per instance). */
export const JOB_POLLING_INTERVAL_SECONDS = 2;

/** How long `stop` waits for running handlers on shutdown before abandoning them (they are retried later). */
const STOP_TIMEOUT_MS = 20_000;

/**
 * `JobQueue` on pg-boss, connected with the RUNTIME login (`DB_APP_*`): the schema is installed and upgraded only by
 * migrations (owner login), so pg-boss starts with `migrate: false` and refuses to start against a schema of another
 * version. Workers (`work` fetching, maintenance and cron) run only with `JOB_WORKERS_ENABLED` (default true; the
 * e2e set it to false and a spec opts in with `createTestApp({ env: { JOB_WORKERS_ENABLED: 'true' } })`). `send`
 * works either way. Started in `onModuleInit` (a wrong schema fails the boot).
 *
 * **Shutdown:** workers must stop (and running handlers drain, graceful, 20 s) before ANY provider a handler may use
 * releases anything. Nest runs destroy -> beforeShutdown -> shutdown, and inside a phase the global modules (this one)
 * come LAST; so `JobQueueDrain`, a provider of the ROOT module (`AppModule`, first in the destroy phase), calls `stop`
 * in its `onModuleDestroy`, before every other `onModuleDestroy`. `onModuleDestroy` here is only the fallback for a
 * context without `JobQueueDrain`. Providers handlers use still release in `onApplicationShutdown` where possible
 * (server key wipe, KMS and S3 clients). Fixed by test/shared/jobs.e2e-spec.ts ("shutdown drains ...").
 */
@Injectable()
export class PgBossJobQueue
  extends JobQueue
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PgBossJobQueue.name);
  private readonly queues = new Map<string, Promise<void>>();
  private readonly handlers = new Map<string, JobHandler<JobPayload>>();
  private readonly ready: Promise<PgBoss>;
  private resolveReady!: (boss: PgBoss) => void;
  private boss: PgBoss | undefined;
  private workersEnabled = false;
  private stopped: Promise<void> | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    super();
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  // Configuration is read here, not in the constructor: createTestApp({ env }) patches ConfigService after the
  // providers are built and before init.
  async onModuleInit(): Promise<void> {
    const config = this.config;
    // Boolean from the validated env; a string when a spec patches it.
    const workers = config.get<boolean | string>('JOB_WORKERS_ENABLED');
    this.workersEnabled =
      workers === undefined || workers === true || workers === 'true';
    const boss = new PgBoss({
      host: config.getOrThrow<string>('DB_HOST'),
      port: Number(config.getOrThrow('DB_PORT')),
      database: config.getOrThrow<string>('DB_DATABASE'),
      user: config.getOrThrow<string>('DB_APP_USERNAME'),
      password: config.getOrThrow<string>('DB_APP_PASSWORD'),
      schema: JOB_QUEUE_SCHEMA,
      application_name: 'jobs',
      max: JOB_QUEUE_POOL_MAX,
      connectionTimeoutMillis: 10_000,
      migrate: false,
      createSchema: false,
      supervise: this.workersEnabled,
      schedule: this.workersEnabled,
      // No DDL from the runtime login: no index rebuilds, no queue-stats partitions.
      reindex: false,
      persistQueueStats: false,
      openTelemetry: { enabled: false },
    });
    // pg-boss errors carry SQL and ids (payloads are ids only); still, only the message is logged.
    boss.on('error', (error: Error) => {
      this.logger.error(`job queue error: ${error.message}`);
    });
    boss.on('warning', (warning: { message?: string }) => {
      this.logger.warn(`job queue warning: ${warning.message ?? 'unknown'}`);
    });
    await boss.start();
    this.boss = boss;
    this.resolveReady(boss);
    // Handlers registered before the start (another module's onModuleInit ran first).
    for (const [name, handler] of this.handlers) {
      await this.subscribe(boss, name, handler);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Stops fetching and waits for running handlers (idempotent). After it, `send` and `work` are not available. */
  stop(): Promise<void> {
    if (!this.stopped) {
      const boss = this.boss;
      this.boss = undefined;
      this.stopped = boss
        ? boss.stop({ graceful: true, close: true, timeout: STOP_TIMEOUT_MS })
        : Promise.resolve();
    }
    return this.stopped;
  }

  async send<P extends JobPayload>(
    name: string,
    payload: P,
    options: JobSendOptions = {},
  ): Promise<string | null> {
    assertQueueName(name);
    const data = { ...assertIdsOnlyPayload(payload) };
    const { startAfterSeconds, singletonKey } = assertSendOptions(options);
    const boss = await this.ready;
    await this.ensureQueue(boss, name);
    const db = this.transactionDb();
    if (singletonKey !== undefined) {
      const res = await boss.upsert(name, data, {
        singletonKey,
        startAfter: startAfterSeconds ?? 0,
        db,
      });
      return res.jobs[0] ?? null;
    }
    return boss.send(name, data, {
      startAfter: startAfterSeconds,
      db,
    });
  }

  async sendMany<P extends JobPayload>(
    name: string,
    jobs: readonly {
      payload: P;
      singletonKey?: string;
      startAfterSeconds?: number;
    }[],
  ): Promise<number> {
    assertQueueName(name);
    if (jobs.length === 0) return 0;
    const rows = jobs.map((j) => {
      const data = { ...assertIdsOnlyPayload(j.payload) };
      assertSendOptions({
        singletonKey: j.singletonKey,
        startAfterSeconds: j.startAfterSeconds,
      });
      return {
        data,
        singletonKey: j.singletonKey,
        ...(j.startAfterSeconds !== undefined
          ? { startAfter: j.startAfterSeconds }
          : {}),
      };
    });
    const boss = await this.ready;
    await this.ensureQueue(boss, name);
    // One INSERT ... SELECT FROM json_to_recordset (ON CONFLICT DO NOTHING: a waiting singleton is kept).
    const ids = await boss.insert(name, rows, {
      db: this.transactionDb(),
      returnId: true,
    });
    return ids?.length ?? 0;
  }

  async work<P extends JobPayload>(
    name: string,
    handler: JobHandler<P>,
  ): Promise<void> {
    assertQueueName(name);
    if (this.handlers.has(name)) {
      throw new Error(`job queue ${name} already has a handler`);
    }
    this.handlers.set(name, handler as JobHandler<JobPayload>);
    // Before the start, onModuleInit subscribes it.
    if (this.boss) {
      await this.subscribe(this.boss, name, handler as JobHandler<JobPayload>);
    }
  }

  async cancelQueued(name: string, match: JobPayload): Promise<number> {
    assertQueueName(name);
    const data = { ...assertIdsOnlyPayload(match) };
    const boss = await this.ready;
    const db = this.transactionDb() ?? boss.getDb();
    // One statement guarded by the state, not pg-boss findJobs + deleteJob (delete by id, without a state check): a
    // job a worker fetched between the two would be deleted while running. A row the fetch is turning `active` is
    // locked; this DELETE waits for it and re-checks the predicate on the new row (READ COMMITTED), so it skips it.
    // Only `created`/`retry` rows go, which pg-boss's retained counters never include.
    const { rows } = await db.executeSql(
      `WITH deleted AS (
         DELETE FROM ${JOB_QUEUE_SCHEMA}.job
         WHERE name = $1 AND state < 'active' AND data @> $2::jsonb
         RETURNING 1
       )
       SELECT count(*)::int AS count FROM deleted`,
      [name, JSON.stringify(data)],
    );
    return (rows[0] as { count: number }).count;
  }

  /** Runs one job; a failure reaches pg-boss (stored in the job row) and the log only as its error type. */
  private async run<P extends JobPayload>(
    name: string,
    job: Job<P>,
    handler: JobHandler<P>,
  ): Promise<void> {
    try {
      await handler(job.data, {
        id: job.id,
        retryCount: job.retryCount,
        signal: job.signal,
      });
    } catch (error) {
      const kind =
        error instanceof DomainError
          ? error.code
          : error instanceof Error
            ? error.name
            : 'unknown';
      // Never the message nor the stack: an error raised while handling legible content could quote it.
      this.logger.warn(
        `job ${name} ${job.id} failed (attempt ${job.retryCount + 1}): ${kind}`,
      );
      throw new Error(`job failed: ${kind}`);
    }
  }

  /** Without workers in this process the handler is only kept (nothing is fetched); the queue is created either way. */
  private async subscribe(
    boss: PgBoss,
    name: string,
    handler: JobHandler<JobPayload>,
  ): Promise<void> {
    // The queue exists from the boot (also without workers): `send` inside a unit of work then never creates it on the
    // pg-boss pool while the transaction holds a TypeORM connection.
    await this.ensureQueue(boss, name);
    if (!this.workersEnabled) return;
    await boss.work<JobPayload>(
      name,
      { batchSize: 1, pollingIntervalSeconds: JOB_POLLING_INTERVAL_SECONDS },
      async ([job]: Job<JobPayload>[]) => {
        if (job) await this.run(name, job, handler);
      },
    );
  }

  private ensureQueue(boss: PgBoss, name: string): Promise<void> {
    let created = this.queues.get(name);
    if (!created) {
      // Idempotent (ON CONFLICT DO NOTHING); autocommit on the pg-boss pool, outside any unit of work.
      created = boss.createQueue(name, JOB_QUEUE_DEFAULTS);
      created.catch(() => this.queues.delete(name));
      this.queues.set(name, created);
    }
    return created;
  }

  /** The connection of the active unit of work, if any, so the job commits (or rolls back) with it. */
  private transactionDb(): Db | undefined {
    const runner = currentManager(this.dataSource).queryRunner;
    if (!runner?.isTransactionActive) return undefined;
    return {
      executeSql: async (text: string, values?: unknown[]) => {
        const result = await runner.query(text, values, true);
        return { rows: (result.records ?? []) as unknown[] };
      },
    };
  }
}
