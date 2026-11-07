import { Injectable } from '@nestjs/common';
import {
  PlatformAuditLogRepository,
  type PlatformAuditEntry,
} from '../domain/platform-audit-log.repository.js';

export type {
  PlatformAuditAction,
  PlatformAuditEntry,
} from '../domain/platform-audit-log.repository.js';

// Trilha da equipe (spec §4.5). Chamar dentro do UnitOfWork.run do caso de uso: a auditoria entra (ou sai) junto
// com a mudança. O que mexe numa organização vai também para o AuditLog dela (exportado pelo organizations).
@Injectable()
export class PlatformAudit {
  constructor(private readonly repository: PlatformAuditLogRepository) {}

  async record(entry: PlatformAuditEntry): Promise<void> {
    await this.repository.append(entry);
  }
}
