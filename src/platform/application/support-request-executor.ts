import { Injectable } from '@nestjs/common';
import { HubAdministration } from '../../hubs/application/hub-administration.js';
import { OrganizationAdministration } from '../../organizations/application/organization-administration.js';
import type { AuditActor } from '../../shared/application/audit-actor.js';
import {
  DomainError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { PlatformRoleRepository } from '../domain/platform-role.repository.js';
import type { SupportRequest } from '../domain/support-request.js';
import { SupportRequestRepository } from '../domain/support-request.repository.js';
import { PlatformAudit } from './platform-audit.js';
import { supportRequestAuditEntry } from './support-request-audit.js';

export function staffCannotBeAppointed(): DomainValidationError {
  return new DomainValidationError(
    'staff-cannot-be-appointed',
    'An account with a platform role cannot be appointed as an organization admin.',
  );
}

// Executa um pedido já aprovado (status pending + decisor), DENTRO do UnitOfWork.run de quem chama, depois de a
// aprovação estar gravada. A ação roda num `uow.run` ANINHADO (savepoint): um erro de domínio desfaz só a ação e o
// pedido fica `failed` com o `type` do erro, gravado e auditado na transação de fora (nada muda no alvo). Qualquer
// outro erro (banco, programação) sobe e desfaz tudo, aprovação inclusive.
@Injectable()
export class SupportRequestExecutor {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly hubs: HubAdministration,
    private readonly orgs: OrganizationAdministration,
    private readonly roles: PlatformRoleRepository,
    private readonly repo: SupportRequestRepository,
    private readonly audit: PlatformAudit,
  ) {}

  async execute(request: SupportRequest, now: Date): Promise<void> {
    const actor: AuditActor = {
      kind: 'platform',
      supportRequestId: request.id,
    };
    try {
      await this.uow.run(() => this.act(request, actor, now));
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      request.markFailed(err.code);
      await this.repo.save(request);
      await this.audit.record(
        supportRequestAuditEntry(
          request,
          'platform.request.failed',
          request.decidedBy,
          { failureType: err.code },
        ),
      );
      return;
    }
    request.markExecuted(now);
    await this.repo.save(request);
    await this.audit.record(
      supportRequestAuditEntry(
        request,
        'platform.request.executed',
        request.decidedBy,
      ),
    );
  }

  private async act(
    request: SupportRequest,
    actor: AuditActor,
    now: Date,
  ): Promise<void> {
    if (request.type === 'hub_force_deregister') {
      await this.hubs.deregister(request.targetHubId!, actor);
      return;
    }
    const userId = request.targetUserId!;
    // Again at execution: the target may have got a platform role after the request (spec §4.4).
    if (await this.roles.hasAnyRole(userId)) throw staffCannotBeAppointed();
    await this.orgs.appointAdmin(
      request.targetOrganizationId!,
      userId,
      actor,
      now,
    );
  }
}
