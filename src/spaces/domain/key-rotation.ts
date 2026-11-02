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

/**
 * What the app needs to retry a mismatched request without guessing: the expected set, what is missing, what is
 * not expected and what was sent twice (sorted). Only ids the caller may know (members of the space, its Room hubs,
 * version numbers).
 */
function setDiff<T extends string | number>(
  sent: readonly T[],
  expected: readonly T[],
) {
  const sentSet = new Set(sent);
  const expectedSet = new Set(expected);
  const seen = new Set<T>();
  const duplicated = new Set<T>();
  for (const x of sent) {
    if (seen.has(x)) duplicated.add(x);
    seen.add(x);
  }
  const sort = (xs: Iterable<T>) =>
    [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    expected: sort(expectedSet),
    missing: sort([...expectedSet].filter((x) => !sentSet.has(x))),
    unexpected: sort([...sentSet].filter((x) => !expectedSet.has(x))),
    duplicated: sort(duplicated),
  };
}

export const KeyRotationRules = {
  /**
   * Rotation: grants must be exactly the active members, no duplicates, nobody missing or extra. The 409 carries
   * `details: { expectedUserIds, missingUserIds, unexpectedUserIds, duplicatedUserIds }`.
   */
  assertGrantsMatchMembers(
    grantUserIds: readonly string[],
    activeMemberIds: readonly string[],
  ): void {
    if (!sameSet(grantUserIds, activeMemberIds)) {
      const d = setDiff(grantUserIds, activeMemberIds);
      throw new ConflictError(
        'key-rotation-mismatch',
        'The grants must cover exactly the active members of the space.',
        {
          expectedUserIds: d.expected,
          missingUserIds: d.missing,
          unexpectedUserIds: d.unexpected,
          duplicatedUserIds: d.duplicated,
        },
      );
    }
  },

  /**
   * Rotation: the Hub copies must be exactly the Hubs with the space open in their Room (people and Hubs are
   * compared the same way, same 409 so the app reloads `GET /spaces/:id` -> `roomHubs`). The 409 carries
   * `details: { expectedHubIds, missingHubIds, unexpectedHubIds, duplicatedHubIds }`.
   */
  assertHubGrantsMatchRoom(
    grantHubIds: readonly string[],
    roomHubIds: readonly string[],
  ): void {
    if (!sameSet(grantHubIds, roomHubIds)) {
      const d = setDiff(grantHubIds, roomHubIds);
      throw new ConflictError(
        'key-rotation-mismatch',
        'The hub grants must cover exactly the hubs with the space in their room.',
        {
          expectedHubIds: d.expected,
          missingHubIds: d.missing,
          unexpectedHubIds: d.unexpected,
          duplicatedHubIds: d.duplicated,
        },
      );
    }
  },

  /**
   * Adding a member: grants must cover every existing key version (1..current), no duplicates. The 409 carries
   * `details: { expectedVersions, missingVersions, unexpectedVersions, duplicatedVersions }`.
   */
  assertGrantsCoverVersions(
    grantVersions: readonly number[],
    existingVersions: readonly number[],
  ): void {
    if (!sameSet(grantVersions, existingVersions)) {
      const d = setDiff(grantVersions, existingVersions);
      throw new ConflictError(
        'key-versions-mismatch',
        'The grants must cover every existing key version of the space.',
        {
          expectedVersions: d.expected,
          missingVersions: d.missing,
          unexpectedVersions: d.unexpected,
          duplicatedVersions: d.duplicated,
        },
      );
    }
  },
};
