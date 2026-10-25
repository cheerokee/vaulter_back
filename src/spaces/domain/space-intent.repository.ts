import type { SpaceRoleKey } from './space-membership.js';

export type SpaceIntent = { spaceId: string; roleKey: SpaceRoleKey };

export abstract class SpaceIntentRepository {
  abstract record(
    orgId: string,
    invitationId: string,
    intents: readonly SpaceIntent[],
  ): Promise<void>;
  abstract forInvitation(
    orgId: string,
    invitationId: string,
  ): Promise<SpaceIntent[]>;
}
