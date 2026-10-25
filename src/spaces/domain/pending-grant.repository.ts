import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import type { SpaceRoleKey } from './space-membership.js';

export type PendingGrantStatus =
  'pending' | 'granted' | 'declined' | 'cancelled';

export type PendingGrant = {
  id: string;
  spaceId: string;
  userId: string;
  roleKey: SpaceRoleKey;
  invitationId: string | null;
  requestedByUserId: string | null;
  status: PendingGrantStatus;
  createdAt: Date;
};

export type NewPendingGrant = Omit<PendingGrant, 'status' | 'createdAt'>;

export abstract class PendingGrantRepository {
  abstract create(orgId: string, grant: NewPendingGrant): Promise<void>;
  abstract findPending(
    orgId: string,
    spaceId: string,
    userId: string,
  ): Promise<PendingGrant | null>;
  abstract listPending(
    orgId: string,
    spaceId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<PendingGrant>>;
  /** Open pending grants of the space. */
  abstract countPending(orgId: string, spaceId: string): Promise<number>;
  /**
   * Declines the OPEN pending grant `pendingGrantId` of the space (another space's id never matches); returns
   * the user it was for, or null when nothing changed.
   */
  abstract decline(
    orgId: string,
    spaceId: string,
    pendingGrantId: string,
  ): Promise<string | null>;
  abstract markGranted(
    orgId: string,
    spaceId: string,
    userId: string,
  ): Promise<void>;
  /** Cancels every pending row of the user (left the organization); returns how many. */
  abstract cancelForUser(orgId: string, userId: string): Promise<number>;
}
