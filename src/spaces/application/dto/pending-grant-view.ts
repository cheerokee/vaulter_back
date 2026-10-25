import type { SpaceRoleKey } from '../../domain/space-membership.js';

/** A person indicated by an invitation, waiting for a manager to wrap the key (never carries key material). */
export type PendingGrantView = {
  id: string;
  userId: string;
  name: string;
  email: string;
  publicKey: string;
  roleKey: SpaceRoleKey;
  invitationId: string | null;
  requestedByUserId: string | null;
  createdAt: Date;
};
