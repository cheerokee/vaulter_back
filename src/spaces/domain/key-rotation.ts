import { ConflictError } from '../../shared/domain/errors.js';

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return (
    sa.size === a.length &&
    sb.size === b.length &&
    sa.size === sb.size &&
    [...sa].every((x) => sb.has(x))
  );
}

export const KeyRotationRules = {
  /** Rotation: grants must be exactly the active members, no duplicates, nobody missing or extra. */
  assertGrantsMatchMembers(
    grantUserIds: readonly string[],
    activeMemberIds: readonly string[],
  ): void {
    if (!sameSet(grantUserIds, activeMemberIds)) {
      throw new ConflictError(
        'key-rotation-mismatch',
        'The grants must cover exactly the active members of the space.',
      );
    }
  },

  /**
   * Rotation: the Hub copies must be exactly the Hubs with the space open in their Room (people and Hubs are
   * compared the same way, same 409 so the app reloads).
   */
  assertHubGrantsMatchRoom(
    grantHubIds: readonly string[],
    roomHubIds: readonly string[],
  ): void {
    if (!sameSet(grantHubIds, roomHubIds)) {
      throw new ConflictError(
        'key-rotation-mismatch',
        'The hub grants must cover exactly the hubs with the space in their room.',
      );
    }
  },

  /** Adding a member: grants must cover every existing key version (1..current), no duplicates. */
  assertGrantsCoverVersions(
    grantVersions: readonly number[],
    existingVersions: readonly number[],
  ): void {
    if (!sameSet(grantVersions, existingVersions)) {
      throw new ConflictError(
        'key-versions-mismatch',
        'The grants must cover every existing key version of the space.',
      );
    }
  },
};
