import { ConflictError } from '../../shared/domain/errors.js';

const sortIds = <T extends string | number>(xs: Iterable<T>): T[] =>
  [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Expected set, what is missing, what is not expected and what was sent twice (sorted): what the app needs to retry
 * without guessing. Only ids the caller may already know (participants, the executor, version numbers).
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
  const d = {
    expected: sortIds(expectedSet),
    missing: sortIds([...expectedSet].filter((x) => !sentSet.has(x))),
    unexpected: sortIds([...sentSet].filter((x) => !expectedSet.has(x))),
    duplicated: sortIds(duplicated),
  };
  const matches =
    d.missing.length === 0 &&
    d.unexpected.length === 0 &&
    d.duplicated.length === 0;
  return { ...d, matches };
}

/**
 * Key rotation (spec §4.2): the new version goes to EXACTLY the active set, the live participants and the executor
 * (none when there is no executor). Whoever left never gets it; whoever joined in the meantime is not left out.
 * 409 `key-rotation-mismatch` (same code and extension members as the space key rotation).
 */
export function assertRecipientsMatch(
  sent: { userIds: readonly string[]; hubIds: readonly string[] },
  active: { userIds: readonly string[]; hubIds: readonly string[] },
): void {
  const users = setDiff(sent.userIds, active.userIds);
  const hubs = setDiff(sent.hubIds, active.hubIds);
  if (users.matches && hubs.matches) return;
  throw new ConflictError(
    'key-rotation-mismatch',
    'The copies must cover exactly the participants and the executor of the conversation.',
    {
      expectedUserIds: users.expected,
      missingUserIds: users.missing,
      unexpectedUserIds: users.unexpected,
      duplicatedUserIds: users.duplicated,
      expectedHubIds: hubs.expected,
      missingHubIds: hubs.missing,
      unexpectedHubIds: hubs.unexpected,
      duplicatedHubIds: hubs.duplicated,
    },
  );
}

/**
 * A new participant or executor gets every version (1..current) once, else they lose the history.
 * 409 `key-versions-mismatch` (same code as adding a space member).
 */
export function assertVersionsCovered(
  sentVersions: readonly number[],
  currentVersion: number,
): void {
  const all = Array.from({ length: currentVersion }, (_, i) => i + 1);
  const d = setDiff(sentVersions, all);
  if (d.matches) return;
  throw new ConflictError(
    'key-versions-mismatch',
    'The copies must cover every key version of the conversation.',
    {
      expectedVersions: d.expected,
      missingVersions: d.missing,
      unexpectedVersions: d.unexpected,
      duplicatedVersions: d.duplicated,
    },
  );
}

/**
 * "Share with the space": exactly the people of the space who do not participate yet (the app reads the members and
 * the participants, seals for each). 409 `conversation-share-mismatch`.
 */
export function assertShareCoversSpace(
  sentUserIds: readonly string[],
  expectedUserIds: readonly string[],
): void {
  const d = setDiff(sentUserIds, expectedUserIds);
  if (d.matches) return;
  throw new ConflictError(
    'conversation-share-mismatch',
    'Sharing with the space must cover exactly the members who do not participate yet.',
    {
      expectedUserIds: d.expected,
      missingUserIds: d.missing,
      unexpectedUserIds: d.unexpected,
      duplicatedUserIds: d.duplicated,
    },
  );
}

/**
 * Rotation of a conversation with the cloud reserve (spec active-cloud §4.3): the new version must also be sealed for
 * the server key; without the reserve, a server copy is refused (nobody would keep it). Same code and extension members
 * as the space key rotation in the active cloud: 409 `key-rotation-mismatch` with `missingServer: true` or
 * `unexpectedServer: true`.
 */
export function assertServerCopyMatchesReserve(
  serverCopySent: boolean,
  cloudReserve: boolean,
): void {
  if (serverCopySent === cloudReserve) return;
  throw new ConflictError(
    'key-rotation-mismatch',
    cloudReserve
      ? 'The cloud is a reserve executor of the conversation: the new version must also be sealed for the server key.'
      : 'The conversation has no cloud reserve: no copy for the server key is expected.',
    cloudReserve ? { missingServer: true } : { unexpectedServer: true },
  );
}
