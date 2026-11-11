import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { JobQueue } from '../../application/job-queue.js';
import { PgBossJobQueue } from './pg-boss-job-queue.js';

/**
 * Registered in the ROOT module (`AppModule`): Nest runs `onModuleDestroy` from the root outwards and the global
 * modules last, so this is the first destroy hook of the application. It stops the job workers and waits for the
 * running handlers before any module releases what they use (clients, hook registrations, keys).
 */
@Injectable()
export class JobQueueDrain implements OnModuleDestroy {
  constructor(private readonly queue: JobQueue) {}

  async onModuleDestroy(): Promise<void> {
    if (this.queue instanceof PgBossJobQueue) await this.queue.stop();
  }
}
