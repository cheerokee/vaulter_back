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
  /** Whether the organization has an entry with this action whose metadata contains `metadata` (jsonb `@>`). */
  abstract has(
    organizationId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<boolean>;
}
