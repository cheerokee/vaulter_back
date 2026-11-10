import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from '../../shared/domain/errors.js';
import { MAX_CONVERSATION_PARTICIPANTS } from './conversation-limits.js';
import {
  assertExecutorEligible,
  assertParticipantCapacity,
  planDeparture,
} from './participation-rules.js';

const t = (s: number) => new Date(Date.UTC(2026, 10, 9, 12, 0, s));

describe('assertParticipantCapacity', () => {
  it('accepts up to 50 participants and refuses the 51st (409 conversation-participant-limit)', () => {
    expect(MAX_CONVERSATION_PARTICIPANTS).toBe(50);
    expect(() => assertParticipantCapacity(49, 1)).not.toThrow();
    expect(() => assertParticipantCapacity(0, 50)).not.toThrow();
    try {
      assertParticipantCapacity(50, 1);
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError);
      expect((e as ConflictError).code).toBe('conversation-participant-limit');
    }
    expect(() => assertParticipantCapacity(10, 41)).toThrow(ConflictError);
  });
});

describe('planDeparture', () => {
  const people = [
    { userId: 'c', joinedAt: t(3) },
    { userId: 'a', joinedAt: t(1) },
    { userId: 'b', joinedAt: t(2) },
  ];

  it('a non-owner leaves: owner and executor stay', () => {
    expect(
      planDeparture({
        ownerUserId: 'a',
        participants: people,
        leavingUserId: 'b',
        executorOwnerUserId: 'a',
      }),
    ).toEqual({
      conversationEnds: false,
      newOwnerUserId: null,
      executorLeaves: false,
    });
  });

  it('the owner leaves: the oldest remaining participant becomes the owner', () => {
    expect(
      planDeparture({
        ownerUserId: 'a',
        participants: people,
        leavingUserId: 'a',
        executorOwnerUserId: null,
      }),
    ).toEqual({
      conversationEnds: false,
      newOwnerUserId: 'b',
      executorLeaves: false,
    });
  });

  it('ties in joinedAt fall to the smallest user id (stable)', () => {
    expect(
      planDeparture({
        ownerUserId: 'a',
        participants: [
          { userId: 'a', joinedAt: t(1) },
          { userId: 'z', joinedAt: t(2) },
          { userId: 'm', joinedAt: t(2) },
        ],
        leavingUserId: 'a',
        executorOwnerUserId: null,
      }).newOwnerUserId,
    ).toBe('m');
  });

  it('the owner of the executor hub leaves: the executor leaves too', () => {
    expect(
      planDeparture({
        ownerUserId: 'a',
        participants: people,
        leavingUserId: 'c',
        executorOwnerUserId: 'c',
      }),
    ).toEqual({
      conversationEnds: false,
      newOwnerUserId: null,
      executorLeaves: true,
    });
  });

  it('the last participant leaves: the conversation ends (tombstone)', () => {
    expect(
      planDeparture({
        ownerUserId: 'a',
        participants: [{ userId: 'a', joinedAt: t(1) }],
        leavingUserId: 'a',
        executorOwnerUserId: 'a',
      }),
    ).toEqual({
      conversationEnds: true,
      newOwnerUserId: null,
      executorLeaves: true,
    });
  });

  it('someone who is not a participant cannot leave (404)', () => {
    expect(() =>
      planDeparture({
        ownerUserId: 'a',
        participants: people,
        leavingUserId: 'x',
        executorOwnerUserId: null,
      }),
    ).toThrow(NotFoundError);
  });
});

describe('assertExecutorEligible', () => {
  it('accepts a hub whose owner participates and that has the space installed', () => {
    expect(() =>
      assertExecutorEligible({
        hubOwnerUserId: 'a',
        participantUserIds: ['a', 'b'],
        spaceInstalled: true,
      }),
    ).not.toThrow();
  });

  it.each([
    [
      'owner does not participate',
      { hubOwnerUserId: 'z', spaceInstalled: true },
    ],
    ['space not installed', { hubOwnerUserId: 'a', spaceInstalled: false }],
    ['hub not found', { hubOwnerUserId: null, spaceInstalled: true }],
  ])('refuses when %s (422 executor-invalid)', (_, facts) => {
    try {
      assertExecutorEligible({ participantUserIds: ['a', 'b'], ...facts });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainValidationError);
      expect((e as DomainValidationError).code).toBe('executor-invalid');
    }
  });
});
