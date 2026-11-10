import type { Logger } from '@nestjs/common';
import type { ObjectStore } from '../../storage/application/ports/object-store.js';
import { attachmentKey } from '../domain/attachment-keys.js';
import type { PurgedAttachment } from '../domain/conversation-attachment.repository.js';

/**
 * After the COMMIT that marked the attachments `purged` (with a fresh journal mark): deletes their S3 versions in
 * batched calls (`ObjectStore.deleteVersions`, the same as the backup trash). Never throws: what was not deleted keeps
 * its mark, so the reconcile sweep (`storage:reconcile`, hook `conversations.attachments`) removes it; a `purged` row
 * references no version, so the repair deletes it. Returns how many versions left the bucket.
 */
export async function removePurgedAttachments(
  store: ObjectStore,
  purged: readonly PurgedAttachment[],
  logger: Logger,
): Promise<number> {
  if (purged.length === 0) return 0;
  try {
    const { failed } = await store.deleteVersions(
      purged.map((a) => ({ key: attachmentKey(a), versionId: a.s3VersionId })),
    );
    if (failed.length > 0) {
      logger.warn(
        { failed: failed.length },
        'could not delete purged conversation attachments from the bucket; the reconcile sweep removes them',
      );
    }
    return purged.length - failed.length;
  } catch (error) {
    logger.warn(
      { err: error, attachments: purged.length },
      'could not delete purged conversation attachments from the bucket; the reconcile sweep removes them',
    );
    return 0;
  }
}

export function bytesOfAttachments(
  purged: readonly PurgedAttachment[],
): number {
  return purged.reduce((sum, a) => sum + a.sizeBytes, 0);
}
