import { Injectable } from '@nestjs/common';
import { JobQueue } from '../../../shared/application/job-queue.js';
import { INDEX_SPACE_DEBOUNCE_SECONDS } from '../../domain/indexing-limits.js';

/** Reindex a space from its manifests (`IndexSpaceJob`). Payload: `{ organizationId, spaceId }`. */
export const INDEX_SPACE_QUEUE = 'cloud.index-space';
/** Index one file (`IndexFileJob`). Payload: `{ organizationId, spaceId, cloudFileId }`. */
export const INDEX_FILE_QUEUE = 'cloud.index-file';

export type IndexSpacePayload = { organizationId: string; spaceId: string };
export type IndexFilePayload = IndexSpacePayload & { cloudFileId: string };

// As tarefas da indexação (pg-boss). Seguem a convenção de `CloudSpaceJobs` (payload com `organizationId` e `spaceId`,
// filas registradas lá: desligar cancela as que esperam). Chamadas dentro de um unit of work entram na transação dele.
@Injectable()
export class CloudIndexingQueue {
  constructor(private readonly jobs: JobQueue) {}

  /**
   * One waiting reindex per space (`singletonKey`): a burst of uploads becomes one pass. `debounce` waits
   * `INDEX_SPACE_DEBOUNCE_SECONDS` (changes in the backup); switching on starts at once.
   */
  async enqueueSpace(
    organizationId: string,
    spaceId: string,
    options: { debounce: boolean },
  ): Promise<void> {
    await this.jobs.send<IndexSpacePayload>(
      INDEX_SPACE_QUEUE,
      { organizationId, spaceId },
      {
        singletonKey: `space:${spaceId}`,
        startAfterSeconds: options.debounce ? INDEX_SPACE_DEBOUNCE_SECONDS : 0,
      },
    );
  }

  /** One job per file row, all in ONE statement (a file that already has a waiting job is skipped). */
  async enqueueFiles(
    organizationId: string,
    spaceId: string,
    cloudFileIds: readonly string[],
  ): Promise<void> {
    await this.jobs.sendMany<IndexFilePayload>(
      INDEX_FILE_QUEUE,
      cloudFileIds.map((cloudFileId) => ({
        payload: { organizationId, spaceId, cloudFileId },
        singletonKey: `file:${cloudFileId}`,
      })),
    );
  }

  /** One waiting job per file row. */
  async enqueueFile(
    organizationId: string,
    spaceId: string,
    cloudFileId: string,
  ): Promise<void> {
    await this.jobs.send<IndexFilePayload>(
      INDEX_FILE_QUEUE,
      { organizationId, spaceId, cloudFileId },
      { singletonKey: `file:${cloudFileId}` },
    );
  }
}
