import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import {
  decodeCursor,
  pageFrom,
  type CursorPage,
  type CursorPageRequest,
} from '../../../shared/domain/pagination.js';
import {
  PlatformAuditLogRepository,
  type PlatformAuditEntry,
  type PlatformAuditFilter,
  type PlatformAuditRecord,
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

  async list(
    filter: PlatformAuditFilter,
    page: CursorPageRequest,
  ): Promise<CursorPage<PlatformAuditRecord>> {
    const q = currentManager(this.dataSource)
      .getRepository(PlatformAuditLogTypeormEntity)
      .createQueryBuilder('a');
    if (filter.supportRequestId) {
      q.andWhere('a.supportRequestId = :sr', { sr: filter.supportRequestId });
    }
    if (filter.requestedBy) {
      q.andWhere(
        `a.supportRequestId IN (SELECT r.id FROM platform_support_requests r WHERE r.requested_by_user_id = :by)`,
        { by: filter.requestedBy },
      );
    }
    if (page.cursor) {
      q.andWhere('a.id < :cursor', { cursor: decodeCursor(page.cursor) });
    }
    const rows = await q
      .orderBy('a.id', 'DESC')
      .limit(page.limit + 1)
      .getMany();
    return pageFrom(
      rows.map((r): PlatformAuditRecord => ({
        id: r.id,
        createdAt: r.createdAt,
        userId: r.userId,
        action: r.action as PlatformAuditRecord['action'],
        result: r.result,
        ...(r.supportRequestId ? { supportRequestId: r.supportRequestId } : {}),
        ...(r.targetUserId ? { targetUserId: r.targetUserId } : {}),
        ...(r.targetHubId ? { targetHubId: r.targetHubId } : {}),
        ...(r.targetOrganizationId
          ? { targetOrganizationId: r.targetOrganizationId }
          : {}),
        ...(r.metadata
          ? { metadata: r.metadata as Record<string, unknown> }
          : {}),
      })),
      page.limit,
      (r) => r.id,
    );
  }
}
