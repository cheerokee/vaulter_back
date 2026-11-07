import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import {
  PlatformAuditLogRepository,
  type PlatformAuditRecord,
} from '../domain/platform-audit-log.repository.js';
import { PlatformAccess } from './platform-access.js';

export type ListPlatformAuditQuery = CursorPageRequest & {
  supportRequestId?: string;
};

// Lista a trilha da plataforma (`platform.audit.read`; 404 sem). Quem não tem `platform.support.approve` vê só as
// linhas dos pedidos que criou (mesma regra da lista de pedidos).
@Injectable()
export class ListPlatformAuditUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly repo: PlatformAuditLogRepository,
  ) {}

  async execute(
    actor: Actor,
    query: ListPlatformAuditQuery,
  ): Promise<CursorPage<PlatformAuditRecord>> {
    const permissions = await this.access.require(
      actor.userId,
      'platform.audit.read',
    );
    const seesAll = permissions.includes('platform.support.approve');
    return this.repo.list(
      {
        ...(query.supportRequestId
          ? { supportRequestId: query.supportRequestId }
          : {}),
        ...(seesAll ? {} : { requestedBy: actor.userId }),
      },
      { cursor: query.cursor, limit: query.limit },
    );
  }
}
