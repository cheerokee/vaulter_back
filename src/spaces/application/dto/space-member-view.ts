import type { SpaceRoleKey } from '../../domain/space-membership.js';

/** A member of the space; `publicKey` lets a manager wrap the key for them. */
export type SpaceMemberView = {
  userId: string;
  name: string;
  email: string;
  publicKey: string;
  roleKey: SpaceRoleKey;
  joinedAt: Date;
};
