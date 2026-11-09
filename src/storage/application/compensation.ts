import { Logger } from '@nestjs/common';
import type { ObjectStore } from './ports/object-store.js';

/** S3 versions written inside a unit of work that may still roll back. */
export type WrittenVersion = { key: string; versionId: string };

const logger = new Logger('StorageCompensation');

/**
 * Runs `work` (which wraps a `UnitOfWork.run`) and, if it fails, removes every S3 version it wrote (copies or delete
 * markers), newest first: the index did not commit, so the bucket's current version must go back to what the index
 * says (a version left noncurrent by a stray write would expire in 30 days). Best effort: a failed removal is logged
 * and the original error is rethrown.
 */
export async function withCompensation<T>(
  store: ObjectStore,
  work: (written: WrittenVersion[]) => Promise<T>,
): Promise<T> {
  const written: WrittenVersion[] = [];
  try {
    return await work(written);
  } catch (error) {
    for (const w of [...written].reverse()) {
      try {
        await store.deleteVersion(w.key, w.versionId);
      } catch (cleanup) {
        logger.error(
          { err: cleanup, key: w.key, versionId: w.versionId },
          'could not remove an S3 version of a rolled back storage write',
        );
      }
    }
    throw error;
  }
}
