export type PlatformAuditAction =
  | 'platform.role.granted'
  | 'platform.role.revoked'
  | 'platform.request.created'
  | 'platform.request.approved'
  | 'platform.request.rejected'
  | 'platform.request.executed'
  | 'platform.request.failed'
  | 'platform.request.expired'
  | 'platform.lookup.user'
  | 'platform.lookup.hub'
  | 'platform.lookup.organization';

import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';

export type PlatformAuditResult = 'success' | 'denied' | 'error';

export type PlatformAuditEntry = {
  /** Who acted; null for the command line (platform:grant-admin) and the clock (a support request expiring). */
  userId: string | null;
  action: PlatformAuditAction;
  result: PlatformAuditResult;
  supportRequestId?: string;
  targetUserId?: string;
  targetHubId?: string;
  targetOrganizationId?: string;
  /** Never a secret (proofs, tokens, keys, sealed copies): ids, role keys, error types. */
  metadata?: Record<string, unknown>;
};

export type PlatformAuditRecord = PlatformAuditEntry & {
  id: string;
  createdAt: Date;
};

export type PlatformAuditFilter = {
  supportRequestId?: string;
  /** Only rows of support requests created by this person (staff without `platform.support.approve`). */
  requestedBy?: string;
};

// Trilha da equipe (platform_audit_logs), só de acréscimo.
export abstract class PlatformAuditLogRepository {
  abstract append(entry: PlatformAuditEntry): Promise<void>;
  /** Newest first (by id, cursor). */
  abstract list(
    filter: PlatformAuditFilter,
    page: CursorPageRequest,
  ): Promise<CursorPage<PlatformAuditRecord>>;
}
