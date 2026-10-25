import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import {
  AuditLogRepository,
  type AuditEntry,
} from '../../domain/audit-log.repository.js';
import { AuditLogTypeormEntity } from './audit-log.entity.js';

// Só INSERT (o papel de runtime nem tem UPDATE/DELETE na tabela). Nesta etapa toda ação gravada é `success`.
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
}
