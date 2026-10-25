import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import type { Membership } from './membership.js';

export abstract class MembershipRepository {
  /** Clears the tombstone when the link existed before (no new row). */
  abstract add(orgId: string, userId: string, now: Date): Promise<void>;
  /** Tombstone (soft delete). */
  abstract remove(orgId: string, userId: string): Promise<void>;
  /** Active membership only, with its organization role; null otherwise. */
  abstract find(orgId: string, userId: string): Promise<Membership | null>;
  /**
   * `SELECT 1 ... FOR SHARE` on the ACTIVE link (organization_id, user_id); true when it exists. REQUIRES an
   * active unit of work: the share lock lasts until the end of the transaction, so a concurrent removal (an
   * UPDATE of the same row) waits, and a removal that committed first makes it return false.
   */
  abstract lockActive(orgId: string, userId: string): Promise<boolean>;
  abstract list(
    orgId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<Membership>>;
  abstract countActive(orgId: string): Promise<number>;
  /** Active members holding org_admin. */
  abstract countAdmins(orgId: string): Promise<number>;
}
