import type { SpaceRoleKey } from './space-membership.js';

export type SpaceIntent = { spaceId: string; roleKey: SpaceRoleKey };
/** A recorded intent: who indicated the space (null on rows recorded before the column existed). */
export type StoredSpaceIntent = SpaceIntent & {
  requestedByUserId: string | null;
};

export abstract class SpaceIntentRepository {
  abstract record(
    orgId: string,
    invitationId: string,
    intents: readonly SpaceIntent[],
    /** The inviter (a manager of each space); becomes the pending grant's requested_by on accept. */
    requestedByUserId: string,
  ): Promise<void>;
  abstract forInvitation(
    orgId: string,
    invitationId: string,
  ): Promise<StoredSpaceIntent[]>;
}
