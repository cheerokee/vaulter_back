import { Injectable } from '@nestjs/common';
import { AuditLogRepository } from '../domain/audit-log.repository.js';

/** Actions recorded at this stage. New modules add theirs here. */
export type AuditAction =
  | 'organization.created'
  | 'organization.updated'
  | 'organization.recovery_key.registered'
  | 'organization.recovery_key.replaced'
  | 'member.joined'
  | 'member.left'
  | 'member.removed'
  | 'member.role_changed'
  | 'invitation.created'
  | 'invitation.revoked';

export type AuditRecord = {
  organizationId: string;
  userId: string | null;
  action: AuditAction;
  /** Never a secret (tokens, keys, proofs) and kept minimal: ids, role keys, field names. */
  metadata?: Record<string, unknown>;
};

// Serviço exportado para os outros módulos gravarem no audit_logs. Chamar dentro do UnitOfWork.run do caso
// de uso: a auditoria entra (ou sai) junto com a mudança.
@Injectable()
export class AuditLog {
  constructor(private readonly repository: AuditLogRepository) {}

  async record(entry: AuditRecord): Promise<void> {
    await this.repository.append({
      organizationId: entry.organizationId,
      userId: entry.userId,
      action: entry.action,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    });
  }
}
