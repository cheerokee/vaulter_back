import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import {
  PlatformAuditLogRepository,
  type PlatformAuditEntry,
} from '../../domain/platform-audit-log.repository.js';
import { PlatformAuditLogTypeormEntity } from './platform-audit-log.entity.js';

// Só INSERT (o papel de runtime nem tem UPDATE/DELETE na tabela).
@Injectable()
export class PlatformAuditLogTypeormRepository extends PlatformAuditLogRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async append(entry: PlatformAuditEntry): Promise<void> {
    await currentManager(this.dataSource)
      .getRepository(PlatformAuditLogTypeormEntity)
      .insert({
        userId: entry.userId,
        action: entry.action,
        result: entry.result,
        supportRequestId: entry.supportRequestId ?? null,
        targetUserId: entry.targetUserId ?? null,
        targetHubId: entry.targetHubId ?? null,
        targetOrganizationId: entry.targetOrganizationId ?? null,
        metadata: entry.metadata ?? null,
      });
  }
}
