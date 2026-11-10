import {
  conversationNotFound,
  conversationParticipantLimit,
  executorInvalid,
} from './conversation-errors.js';
import { MAX_CONVERSATION_PARTICIPANTS } from './conversation-limits.js';

export type LiveParticipant = { userId: string; joinedAt: Date };

/** 409 `conversation-participant-limit` when `liveCount + adding` passes the limit (people; the executor does not count). */
export function assertParticipantCapacity(
  liveCount: number,
  adding: number,
): void {
  if (liveCount + adding > MAX_CONVERSATION_PARTICIPANTS) {
    throw conversationParticipantLimit(MAX_CONVERSATION_PARTICIPANTS);
  }
}

export type DeparturePlan = {
  /** The last participant left: the conversation becomes a tombstone (private stays private). */
  conversationEnds: boolean;
  /** The owner left and others remain: the oldest remaining participant (joinedAt, then user id). */
  newOwnerUserId: string | null;
  /** The owner of the executor Hub left: the executor leaves too (the executor rule, §4.1). */
  executorLeaves: boolean;
};

/**
 * What happens when a participant leaves or is removed (spec §4.2). Every departure also requires a key rotation and
 * tombstones the person's participation and key copies (the use case does both).
 */
export function planDeparture(input: {
  ownerUserId: string;
  participants: readonly LiveParticipant[];
  leavingUserId: string;
  /** Owner of the current executor Hub, or null without an executor. */
  executorOwnerUserId: string | null;
}): DeparturePlan {
  if (!input.participants.some((p) => p.userId === input.leavingUserId)) {
    throw conversationNotFound();
  }
  const remaining = input.participants
    .filter((p) => p.userId !== input.leavingUserId)
    .sort(
      (a, b) =>
        a.joinedAt.getTime() - b.joinedAt.getTime() ||
        (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );
  const conversationEnds = remaining.length === 0;
  const newOwnerUserId =
    !conversationEnds && input.ownerUserId === input.leavingUserId
      ? remaining[0]!.userId
      : null;
  return {
    conversationEnds,
    newOwnerUserId,
    executorLeaves: input.executorOwnerUserId === input.leavingUserId,
  };
}

/**
 * The executor is a Hub whose owner participates in the conversation and that has the space installed (`hub_space`
 * alive, approved link); the Room is not required (decision "a" of the spec, §4.1). `hubOwnerUserId` null = the Hub
 * was not found (deregistered, or not visible to the caller). 422 `executor-invalid`.
 */
export function assertExecutorEligible(input: {
  hubOwnerUserId: string | null;
  participantUserIds: readonly string[];
  spaceInstalled: boolean;
}): void {
  if (
    input.hubOwnerUserId === null ||
    !input.spaceInstalled ||
    !input.participantUserIds.includes(input.hubOwnerUserId)
  ) {
    throw executorInvalid();
  }
}
