import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import type { Invitation } from './invitation.js';

export abstract class InvitationRepository {
  abstract create(invitation: Invitation): Promise<void>;
  /** Through the SECURITY DEFINER function: works before an organization context exists. */
  abstract findByTokenHash(tokenHash: string): Promise<Invitation | null>;
  abstract listPending(
    orgId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<Invitation>>;
  abstract revoke(orgId: string, id: string): Promise<boolean>;
  /** Atomic: only succeeds while pending and unexpired. */
  abstract markAccepted(
    id: string,
    userId: string,
    now: Date,
  ): Promise<boolean>;
}
