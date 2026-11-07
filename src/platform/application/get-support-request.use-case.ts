import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { SupportRequest } from '../domain/support-request.js';
import { SupportRequestRepository } from '../domain/support-request.repository.js';
import { supportRequestNotFound } from './decide-support-request.use-case.js';
import { PlatformAccess } from './platform-access.js';
import { PlatformAudit } from './platform-audit.js';
import { expireIfDue } from './support-request-audit.js';

// Um pedido (`platform.audit.read`; 404 sem). Quem não tem `platform.support.approve` só vê os próprios: o de outra
// pessoa é o mesmo 404 de pedido inexistente. Pendente vencido vira `expired` na leitura (gravado e auditado).
@Injectable()
export class GetSupportRequestUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly repo: SupportRequestRepository,
    private readonly audit: PlatformAudit,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(actor: Actor, id: string): Promise<SupportRequest> {
    const permissions = await this.access.require(
      actor.userId,
      'platform.audit.read',
    );
    const seesAll = permissions.includes('platform.support.approve');
    return this.uow.run(async () => {
      const request = await this.repo.lockById(id);
      if (!request || (!seesAll && request.requestedBy !== actor.userId)) {
        throw supportRequestNotFound();
      }
      await expireIfDue(request, new Date(), this.repo, this.audit);
      return request;
    });
  }
}
