import { ConflictError } from '../../shared/domain/errors.js';

export const OrphanRules = {
  /** Reopening with the kit needs a space with no active member at all. */
  assertOrphan(activeMemberCount: number): void {
    if (activeMemberCount !== 0) {
      throw new ConflictError(
        'space-not-orphan',
        'The space still has active members.',
      );
    }
  },

  /** Promoting a manager is only allowed while the space has none. */
  assertNoManager(managerCount: number): void {
    if (managerCount !== 0) {
      throw new ConflictError(
        'space-has-manager',
        'The space already has a manager.',
      );
    }
  },
};
