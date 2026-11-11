import { Global, Module } from '@nestjs/common';
import { JobQueue } from '../../application/job-queue.js';
import { PgBossJobQueue } from './pg-boss-job-queue.js';

/** Global: any module injects the `JobQueue` port (shared/application) without importing infra. */
@Global()
@Module({
  providers: [{ provide: JobQueue, useClass: PgBossJobQueue }],
  exports: [JobQueue],
})
export class JobsModule {}
