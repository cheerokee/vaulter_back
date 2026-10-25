export type AuditEntry = {
  organizationId: string;
  userId: string | null;
  action: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
};

export abstract class AuditLogRepository {
  /** Append-only. */
  abstract append(entry: AuditEntry): Promise<void>;
}
