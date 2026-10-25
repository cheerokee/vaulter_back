import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import type { Session, SessionRevokedReason } from './session.js';

export abstract class SessionRepository {
  abstract create(session: Session): Promise<void>;
  abstract findById(id: string): Promise<Session | null>;
  /** Active sessions (not revoked, not expired at `now`), ordered by id descending. */
  abstract listActiveByUser(
    userId: string,
    now: Date,
    page: CursorPageRequest,
  ): Promise<CursorPage<Session>>;
  /**
   * Conditional UPDATE: persists the session's new refresh state only if the stored hash
   * still equals `expectedHash` and the session is not revoked. Returns false otherwise.
   */
  abstract rotateRefreshToken(
    session: Session,
    expectedHash: string,
  ): Promise<boolean>;
  abstract save(session: Session): Promise<void>;
  abstract revokeAllForUser(
    userId: string,
    reason: SessionRevokedReason,
    now: Date,
    exceptSessionId?: string,
  ): Promise<void>;
}
