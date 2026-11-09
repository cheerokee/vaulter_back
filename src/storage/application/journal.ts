import { storageBusy } from './storage-errors.js';

/**
 * Under the object locks, right before the S3 write: every row of this attempt must still carry a mark at least as
 * recent as the one this attempt wrote (a later attempt may have refreshed it; a sweep may have cleared it). Throws
 * 409 `storage-busy` otherwise: no S3 write ever happens without a mark.
 */
export function assertStillMarked(
  mine: ReadonlyMap<string, Date>,
  current: ReadonlyMap<string, Date>,
  versionIds: readonly string[],
): void {
  for (const id of versionIds) {
    const markedAt = mine.get(id);
    const now = current.get(id);
    if (!markedAt || !now || now.getTime() < markedAt.getTime()) {
      throw storageBusy();
    }
  }
}
