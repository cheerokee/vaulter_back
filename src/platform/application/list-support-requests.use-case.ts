import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type {
  PlatformSupportRequestStatus,
  SupportRequest,
} from '../domain/support-request.js';
import { SupportRequestRepository } from '../domain/support-request.repository.js';
import { PlatformAccess } from './platform-access.js';
import { PlatformAudit } from './platform-audit.js';
import { persistExpiry } from './support-request-audit.js';

export type ListSupportRequestsQuery = CursorPageRequest & {
  status?: PlatformSupportRequestStatus;
};

// Lista os pedidos (`platform.audit.read`; 404 sem). Quem não tem `platform.support.approve` (suporte) vê só os
// próprios. Antes de ler, os pendentes vencidos viram `expired` (gravado e auditado), para a lista e o filtro por
// estado mostrarem o estado real.
@Injectable()
export class ListSupportRequestsUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly repo: SupportRequestRepository,
    private readonly audit: PlatformAudit,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    query: ListSupportRequestsQuery,
  ): Promise<CursorPage<SupportRequest>> {
    const permissions = await this.access.require(
      actor.userId,
      'platform.audit.read',
    );
    const seesAll = permissions.includes('platform.support.approve');
    return this.uow.run(async () => {
      const now = new Date();
      for (const request of await this.repo.lockDuePending(now)) {
        if (request.expireIfDue(now)) {
          await persistExpiry(request, this.repo, this.audit);
        }
      }
      return this.repo.list(
        {
          ...(query.status ? { status: query.status } : {}),
          ...(seesAll ? {} : { requestedBy: actor.userId }),
        },
        { cursor: query.cursor, limit: query.limit },
      );
    });
  }
}
