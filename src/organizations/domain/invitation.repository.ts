import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import type { Invitation } from './invitation.js';

export abstract class InvitationRepository {
  abstract create(invitation: Invitation): Promise<void>;
  /** Works before an organization context exists (RLS policy keyed on `app.invitation_token_hash`). */
  abstract findByTokenHash(tokenHash: string): Promise<Invitation | null>;
  /** Pending and unexpired at `now` (same clock as `markAccepted`). */
  abstract listPending(
    orgId: string,
    page: CursorPageRequest,
    now: Date,
  ): Promise<CursorPage<Invitation>>;
  abstract revoke(orgId: string, id: string): Promise<boolean>;
  /**
   * Revokes every pending, unexpired (`expires_at > now`) invitation of the organization created by `userId`
   * (who just lost `org.members.manage`). Returns the revoked ids, for the audit.
   */
  abstract revokePendingCreatedBy(
    orgId: string,
    userId: string,
    now: Date,
  ): Promise<string[]>;
  /**
   * Atomic: only succeeds while pending and unexpired (`expires_at > now`). `orgId` comes from
   * `findByTokenHash` and sets the RLS context, like every other organization-scoped method.
   */
  abstract markAccepted(
    orgId: string,
    id: string,
    userId: string,
    now: Date,
  ): Promise<boolean>;
}
