import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import type {
  PlatformSupportRequestStatus,
  SupportRequest,
} from './support-request.js';

export type SupportRequestFilter = {
  status?: PlatformSupportRequestStatus;
  /** Only the requests of this person (staff without `platform.support.approve`). */
  requestedBy?: string;
};

// Pedidos de suporte (platform_support_requests). Sem RLS: as tabelas da plataforma não têm organização.
export abstract class SupportRequestRepository {
  abstract insert(request: SupportRequest): Promise<void>;
  /** Writes the mutable fields (status, decision, execution). */
  abstract save(request: SupportRequest): Promise<void>;
  abstract findById(id: string): Promise<SupportRequest | null>;
  /** FOR UPDATE: needs an active unit of work (serializes concurrent decisions on the same request). */
  abstract lockById(id: string): Promise<SupportRequest | null>;
  /**
   * Pending requests without a decision whose deadline passed, locked FOR UPDATE SKIP LOCKED (one being decided
   * right now is skipped: its decision handles the expiry). Needs an active unit of work.
   */
  abstract lockDuePending(now: Date): Promise<SupportRequest[]>;
  /** Newest first (by id, cursor). */
  abstract list(
    filter: SupportRequestFilter,
    page: CursorPageRequest,
  ): Promise<CursorPage<SupportRequest>>;
}
