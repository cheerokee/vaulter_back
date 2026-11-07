export type PlatformAuditAction =
  | 'platform.role.granted'
  | 'platform.role.revoked'
  | 'platform.request.created'
  | 'platform.request.approved'
  | 'platform.request.rejected'
  | 'platform.request.executed'
  | 'platform.request.failed'
  | 'platform.request.expired';

export type PlatformAuditResult = 'success' | 'denied' | 'error';

export type PlatformAuditEntry = {
  /** Who acted; null for the command line (platform:grant-admin). */
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

// Trilha da equipe (platform_audit_logs), só de acréscimo.
export abstract class PlatformAuditLogRepository {
  abstract append(entry: PlatformAuditEntry): Promise<void>;
}
