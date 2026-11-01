export type AuthChallenge = {
  id: string;
  /** Null for the decoy challenge handed out for an unknown hub (it never validates). */
  hubId: string | null;
  challengeHash: string;
  expiresAt: Date;
  usedAt: Date | null;
};

export abstract class AuthChallengeRepository {
  abstract create(challenge: AuthChallenge): Promise<void>;
  /** Conditional single use: the challenge only for the winner; `null` if unknown, used or expired. */
  abstract consume(
    hubId: string,
    challengeHash: string,
    now: Date,
  ): Promise<AuthChallenge | null>;
}
