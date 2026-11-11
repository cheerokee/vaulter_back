import { Injectable } from '@nestjs/common';
import {
  assertQueueName,
  JobQueue,
} from '../../shared/application/job-queue.js';

/**
 * The queues of the cloud's per-space jobs (indexing, reindexing...), so switching a space off cancels what is still
 * waiting for it in the same unit of work.
 *
 * **Convention (every cloud job about a space):** the payload carries `organizationId` and `spaceId` (ids only, see
 * `JobQueue`), and the queue is registered here by the module that owns it (`register` in `onModuleInit`). Switching
 * off calls `JobQueue.cancelQueued(queue, { spaceId })` for each registered queue: waiting jobs are deleted with the
 * deactivation (undone with it on rollback). A job ALREADY RUNNING is not touched: its handler must re-check, under the
 * space lock (`FOR SHARE` is enough: switching off takes it `FOR UPDATE`), that the space is still `active_cloud`
 * before writing anything legible, and stop otherwise.
 */
@Injectable()
export class CloudSpaceJobs {
  private readonly queues = new Set<string>();

  constructor(private readonly jobs: JobQueue) {}

  register(queue: string): void {
    this.queues.add(assertQueueName(queue));
  }

  registered(): string[] {
    return [...this.queues].sort();
  }

  /** Deletes the waiting jobs of the space in every registered queue; returns how many. */
  async cancelForSpace(spaceId: string): Promise<number> {
    let cancelled = 0;
    for (const queue of this.registered()) {
      cancelled += await this.jobs.cancelQueued(queue, { spaceId });
    }
    return cancelled;
  }
}
