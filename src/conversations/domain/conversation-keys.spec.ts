import { ConflictError, NotFoundError } from '../../shared/domain/errors.js';
import { newId } from '../../shared/domain/id.js';
import { Conversation } from './conversation.js';
import {
  assertRecipientsMatch,
  assertServerCopyMatchesReserve,
  assertShareCoversSpace,
  assertVersionsCovered,
} from './conversation-keys.js';

const now = new Date('2026-11-09T12:00:00.000Z');
const blob = () => {
  const b = Buffer.alloc(60, 0xab);
  b[0] = 0x01;
  return b.toString('base64url');
};

const OWNER = newId();
const OTHER = newId();
const HUB = newId();
const [A, B, C] = [newId(), newId(), newId()].sort();

function conflict(fn: () => void): ConflictError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictError);
    return e as ConflictError;
  }
  throw new Error('expected a ConflictError');
}

describe('assertRecipientsMatch (key rotation: exactly the active set)', () => {
  it('accepts exactly the participants and the executor', () => {
    expect(() =>
      assertRecipientsMatch(
        { userIds: [B, A], hubIds: [HUB] },
        { userIds: [A, B], hubIds: [HUB] },
      ),
    ).not.toThrow();
    expect(() =>
      assertRecipientsMatch(
        { userIds: [A], hubIds: [] },
        { userIds: [A], hubIds: [] },
      ),
    ).not.toThrow();
  });

  it('409 key-rotation-mismatch with the missing, unexpected and duplicated ids', () => {
    const e = conflict(() =>
      assertRecipientsMatch(
        { userIds: [A, C, C], hubIds: [] },
        { userIds: [A, B], hubIds: [HUB] },
      ),
    );
    expect(e.code).toBe('key-rotation-mismatch');
    expect(e.details).toEqual({
      expectedUserIds: [A, B],
      missingUserIds: [B],
      unexpectedUserIds: [C],
      duplicatedUserIds: [C],
      expectedHubIds: [HUB],
      missingHubIds: [HUB],
      unexpectedHubIds: [],
      duplicatedHubIds: [],
    });
  });

  it('a hub copy without an executor is unexpected', () => {
    const e = conflict(() =>
      assertRecipientsMatch(
        { userIds: [A], hubIds: [HUB] },
        { userIds: [A], hubIds: [] },
      ),
    );
    expect(e.details).toMatchObject({ unexpectedHubIds: [HUB] });
  });
});

describe('assertVersionsCovered (a new recipient gets every version)', () => {
  it('accepts 1..current exactly once each', () => {
    expect(() => assertVersionsCovered([2, 1, 3], 3)).not.toThrow();
  });

  it('409 key-versions-mismatch otherwise', () => {
    const e = conflict(() => assertVersionsCovered([1, 1, 4], 3));
    expect(e.code).toBe('key-versions-mismatch');
    expect(e.details).toEqual({
      expectedVersions: [1, 2, 3],
      missingVersions: [2, 3],
      unexpectedVersions: [4],
      duplicatedVersions: [1],
    });
  });
});

describe('assertShareCoversSpace (share with the whole space)', () => {
  it('accepts exactly the space members who do not participate yet', () => {
    expect(() => assertShareCoversSpace([B, C], [C, B])).not.toThrow();
  });

  it('409 conversation-share-mismatch with what is missing or extra', () => {
    const e = conflict(() => assertShareCoversSpace([A, B], [B, C]));
    expect(e.code).toBe('conversation-share-mismatch');
    expect(e.details).toEqual({
      expectedUserIds: [B, C],
      missingUserIds: [C],
      unexpectedUserIds: [A],
      duplicatedUserIds: [],
    });
  });
});

describe('Conversation.assertRotationAllowed', () => {
  const make = () =>
    Conversation.restore(
      {
        organizationId: 'org',
        spaceId: 'space',
        createdByUserId: OWNER,
        ownerUserId: OWNER,
        executorHubId: HUB,
        state: 'na_fila',
        lastMessageAt: null,
        currentKeyVersion: 1,
        keyRotationRequired: false,
        encryptedHeader: blob(),
        headerKeyVersion: 1,
        movedFromConversationId: null,
        cloudReserve: false,
        cloudReserveDeclined: false,
        participantUserIds: [OWNER, OTHER],
        createdAt: now,
        deletedAt: null,
      },
      newId(),
    );

  it('with a pending rotation: any participant or the executor', () => {
    const c = make();
    c.markRotationRequired();
    for (const actor of [
      { kind: 'user', userId: OWNER },
      { kind: 'user', userId: OTHER },
      { kind: 'hub', hubId: HUB },
    ] as const) {
      expect(() => c.assertRotationAllowed(actor)).not.toThrow();
    }
  });

  it('without a pending rotation: only the owner (manual), else 409 key-rotation-not-required', () => {
    const c = make();
    expect(() =>
      c.assertRotationAllowed({ kind: 'user', userId: OWNER }),
    ).not.toThrow();
    for (const actor of [
      { kind: 'user', userId: OTHER },
      { kind: 'hub', hubId: HUB },
    ] as const) {
      expect(conflict(() => c.assertRotationAllowed(actor)).code).toBe(
        'key-rotation-not-required',
      );
    }
  });

  it('someone who is neither participant nor executor: 404', () => {
    const c = make();
    c.markRotationRequired();
    expect(() =>
      c.assertRotationAllowed({ kind: 'user', userId: newId() }),
    ).toThrow(NotFoundError);
    expect(() =>
      c.assertRotationAllowed({ kind: 'hub', hubId: newId() }),
    ).toThrow(NotFoundError);
  });
});

describe('assertServerCopyMatchesReserve', () => {
  it('the server copy goes exactly with the cloud reserve (409 with missingServer / unexpectedServer)', () => {
    expect(() => assertServerCopyMatchesReserve(true, true)).not.toThrow();
    expect(() => assertServerCopyMatchesReserve(false, false)).not.toThrow();
    for (const [sent, reserve, member] of [
      [false, true, 'missingServer'],
      [true, false, 'unexpectedServer'],
    ] as const) {
      try {
        assertServerCopyMatchesReserve(sent, reserve);
        throw new Error('expected a conflict');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictError);
        expect((e as ConflictError).code).toBe('key-rotation-mismatch');
        expect((e as ConflictError).details).toEqual({ [member]: true });
      }
    }
  });
});
