import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import {
  AuditLogRepository,
  type AuditEntry,
} from '../../domain/audit-log.repository.js';
import { AuditLogTypeormEntity } from './audit-log.entity.js';

// Só INSERT e leitura (o papel de runtime nem tem UPDATE/DELETE na tabela). Nesta etapa toda ação gravada é `success`.
@Injectable()
export class AuditLogTypeormRepository extends AuditLogRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async append(entry: AuditEntry): Promise<void> {
    await runInOrganizationScope(this.dataSource, entry.organizationId, (m) =>
      m.getRepository(AuditLogTypeormEntity).insert({
        organizationId: entry.organizationId,
        userId: entry.userId,
        action: entry.action,
        scopeType: 'organization',
        result: 'success',
        metadata: entry.metadata ?? null,
        ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
      }),
    );
  }

  async has(
    organizationId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    const rows: unknown[] = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m.query(
          `SELECT 1 FROM audit_logs
            WHERE organization_id = $1 AND action = $2 AND metadata @> $3::jsonb
            LIMIT 1`,
          [organizationId, action, JSON.stringify(metadata)],
        ),
    );
    return rows.length > 0;
  }
}
