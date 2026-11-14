import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobQueue } from '../../shared/application/job-queue.js';
import {
  StorageReconcileHooks,
  type StorageReconcileResult,
} from '../../shared/application/storage-reconcile-hooks.js';
import {
  RECONCILE_DEFAULT_AGE_MINUTES,
  ReconcileStorageUseCase,
} from './reconcile-storage.use-case.js';

export const STORAGE_RECONCILE_QUEUE = 'storage.reconcile';

/**
 * Every day at 04:00 UTC (01:00 in Brasília, low traffic). `conversations:retention` (still a CLI, owner login) must
 * run before it and finish before 03:00 UTC: the marks it renews are only swept once they are 60 min old.
 */
export const STORAGE_RECONCILE_CRON = '0 4 * * *';

export type StorageReconciliationResult = {
  objects: number;
  removedVersions: number;
} & Record<string, StorageReconcileResult | number>;

/**
 * The bucket repair sweep (index × S3): the backup index, then every other index of the bucket
 * (`StorageReconcileHooks`, today the conversations' attachments). Runs as a daily pg-boss job (only in processes with
 * `JOB_WORKERS_ENABLED`) and from the `storage:reconcile` CLI (on demand, e.g. with another age).
 *
 * Idempotent: each row is repaired under its object lock and only marks older than the age are cleared, so a retry
 * (pg-boss: 3, after an error or the 15 min expiry) or a CLI run at the same time repeats nothing harmful. The log
 * carries only counts.
 */
@Injectable()
export class StorageReconciliation implements OnModuleInit {
  private readonly logger = new Logger(StorageReconciliation.name);

  constructor(
    private readonly backup: ReconcileStorageUseCase,
    private readonly hooks: StorageReconcileHooks,
    private readonly jobs: JobQueue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.work(STORAGE_RECONCILE_QUEUE, async () => {
      const result = await this.run();
      this.logger.log(`storage reconcile: ${JSON.stringify(result)}`);
    });
    await this.jobs.schedule(STORAGE_RECONCILE_QUEUE, STORAGE_RECONCILE_CRON);
  }

  async run(
    olderThanMinutes: number = RECONCILE_DEFAULT_AGE_MINUTES,
  ): Promise<StorageReconciliationResult> {
    const result = await this.backup.execute({ olderThanMinutes });
    const others = await this.hooks.run(olderThanMinutes);
    return { ...result, ...others };
  }
}
