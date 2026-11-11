import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  BackupObjectsChangedHooks,
  type BackupObjectsChangedContext,
} from '../../../shared/application/backup-objects-changed-hooks.js';
import { JobQueue } from '../../../shared/application/job-queue.js';
import { SpaceCloud } from '../../../spaces/application/space-cloud.js';
import { CloudSpaceJobs } from '../cloud-space-jobs.js';
import {
  CloudIndexingQueue,
  INDEX_FILE_QUEUE,
  INDEX_SPACE_QUEUE,
  type IndexFilePayload,
  type IndexSpacePayload,
} from './cloud-indexing-queue.js';
import { IndexFileJob } from './index-file.job.js';
import { IndexSpaceJob } from './index-space.job.js';

export const BACKUP_CHANGED_HOOK = 'cloud.indexing';

// Liga a indexação: as duas filas (registradas em `CloudSpaceJobs`, desligar cancela o que espera), os handlers
// (rodam só com JOB_WORKERS_ENABLED) e o gancho do backup: confirmar/apagar num espaço em `active_cloud` enfileira a
// passada do espaço (com debounce), na transação do `storage`. O gancho só LÊ o modo (o `storage` já segura o espaço
// FOR SHARE, então o modo não muda no meio) e nunca trava nada.
@Injectable()
export class CloudIndexingWorkers implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly jobs: JobQueue,
    private readonly spaceJobs: CloudSpaceJobs,
    private readonly hooks: BackupObjectsChangedHooks,
    private readonly spaceCloud: SpaceCloud,
    private readonly queue: CloudIndexingQueue,
    private readonly indexSpace: IndexSpaceJob,
    private readonly indexFile: IndexFileJob,
  ) {}

  async onModuleInit(): Promise<void> {
    this.spaceJobs.register(INDEX_SPACE_QUEUE);
    this.spaceJobs.register(INDEX_FILE_QUEUE);
    this.hooks.register({
      name: BACKUP_CHANGED_HOOK,
      onBackupObjectsChanged: (ctx) => this.onBackupChanged(ctx),
    });
    await this.jobs.work<IndexSpacePayload>(INDEX_SPACE_QUEUE, (payload) =>
      this.indexSpace.run(payload),
    );
    await this.jobs.work<IndexFilePayload>(INDEX_FILE_QUEUE, (payload, job) =>
      this.indexFile.run(payload, job.signal),
    );
  }

  onModuleDestroy(): void {
    this.hooks.unregister(BACKUP_CHANGED_HOOK);
  }

  private async onBackupChanged(
    ctx: BackupObjectsChangedContext,
  ): Promise<void> {
    const mode = await this.spaceCloud.modeOf(ctx.organizationId, ctx.spaceId);
    if (mode !== 'active_cloud') return;
    await this.queue.enqueueSpace(ctx.organizationId, ctx.spaceId, {
      debounce: true,
    });
  }
}
