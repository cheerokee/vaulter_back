import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { CloudTermRules } from '../domain/cloud-term.js';
import {
  CloudTermAcceptanceRepository,
  CloudTermRepository,
} from '../domain/cloud.repositories.js';
import { CLOUD_DECIDER_PERMISSION } from './cloud-space-access.js';
import { toAcceptanceView, type CloudTermsView } from './dto/cloud-views.js';

// O termo atual e o último aceite da organização, para todo membro (o app mostra o texto a quem decide e o aviso a
// todos). Não membro: 404 `organization-not-found`.
@Injectable()
export class GetCloudTermsUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly terms: CloudTermRepository,
    private readonly acceptances: CloudTermAcceptanceRepository,
  ) {}

  async execute(actor: Actor, orgId: string): Promise<CloudTermsView> {
    await this.access.requireMember(orgId, actor.userId);
    const accepted = await this.acceptances.latest(orgId);
    return {
      current: await this.terms.current(),
      accepted: accepted ? toAcceptanceView(accepted) : null,
    };
  }
}

// Aceite do termo pela organização (spec active-cloud §4.1): quem decide (`org.members.manage`; na pessoal, a própria
// pessoa), uma vez por versão, com a versão E o hash do texto mostrado (tela velha: 422 `cloud-terms-outdated`).
// Aceitar de novo a mesma versão devolve o aceite que já existe (sem gravar nem auditar). Auditado
// `organization.cloud_terms.accepted` (versão e hash; o IP fica só na linha do aceite).
@Injectable()
export class AcceptCloudTermsUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly terms: CloudTermRepository,
    private readonly acceptances: CloudTermAcceptanceRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    orgId: string,
    input: { version: number; hash: string; ip: string | null },
  ): Promise<NonNullable<CloudTermsView['accepted']>> {
    await this.access.requirePermission(
      orgId,
      actor.userId,
      CLOUD_DECIDER_PERMISSION,
    );
    return this.uow.run(async () => {
      const term = CloudTermRules.assertAcceptsCurrent(
        await this.terms.current(),
        input.version,
        input.hash,
      );
      const { acceptance, created } = await this.acceptances.acceptOnce({
        organizationId: orgId,
        termVersion: term.version,
        termHash: term.hash,
        acceptedByUserId: actor.userId,
        acceptedAt: new Date(),
        ip: input.ip,
      });
      if (created) {
        await this.audit.record({
          organizationId: orgId,
          userId: actor.userId,
          action: 'organization.cloud_terms.accepted',
          metadata: { termVersion: term.version, termHash: term.hash },
        });
      }
      return toAcceptanceView(acceptance);
    });
  }
}
