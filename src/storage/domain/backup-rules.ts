import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import { MAX_OBJECT_BYTES } from './backup-limits.js';

/** What the rules need of the (locked) space. */
export type WritableSpace = {
  keyRotationRequired: boolean;
  currentKeyVersion: number;
  storageQuotaBytes: number;
};

export const BackupRules = {
  /**
   * New content only with the CURRENT key and no pending rotation (spec §4.2): content encrypted with a version that
   * someone who left knows is refused. 409 `space-key-rotation-required` / `space-key-version-stale`.
   */
  assertWritable(space: WritableSpace, keyVersion: number): void {
    if (space.keyRotationRequired) {
      throw new ConflictError(
        'space-key-rotation-required',
        'The space key must be rotated before new content is accepted.',
      );
    }
    if (keyVersion !== space.currentKeyVersion) {
      throw new ConflictError(
        'space-key-version-stale',
        'The content must be encrypted with the current key version of the space.',
        { currentKeyVersion: space.currentKeyVersion },
      );
    }
  },

  /** 422 `object-too-large` above 5 GiB (the hub splits bigger files). */
  assertObjectSize(objectId: string, sizeBytes: number): void {
    if (sizeBytes > MAX_OBJECT_BYTES) {
      throw new DomainValidationError(
        'object-too-large',
        `An object can have at most ${MAX_OBJECT_BYTES} bytes.`,
        { objectId, maxBytes: MAX_OBJECT_BYTES },
      );
    }
  },

  /** `usedBytes` (committed + trash + live reservations) + `extraBytes` must fit the space size. */
  assertFits(
    space: WritableSpace,
    usedBytes: number,
    extraBytes: number,
  ): void {
    const missingBytes = usedBytes + extraBytes - space.storageQuotaBytes;
    if (missingBytes > 0) {
      throw new DomainValidationError(
        'space-storage-full',
        'The space does not have room for these objects.',
        { missingBytes },
      );
    }
  },

  /** One item per object in a request. */
  assertDistinctObjects(objectIds: readonly string[]): void {
    if (new Set(objectIds).size !== objectIds.length) {
      throw new DomainValidationError(
        'duplicate-object',
        'An object can appear only once per request.',
      );
    }
  },
};
