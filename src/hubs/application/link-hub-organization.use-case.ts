import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubOrganizationLink } from '../domain/hub-organization-link.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import { toHubLinkView, type HubLinkView } from './dto/hub-link-view.js';
import { HubAccess } from './hub-access.js';
import { hubNotFound } from './hub-errors.js';
import { currentLinkPolicy } from './link-policy.js';

// O dono vincula uma organização de que é membro (`POST /hubs/:id/organizations`, spec §4.6): o consentimento do
// dono já fica dado; com `any_member_hub` nasce aprovado, com `admin_approved` fica pendente até um admin aprovar.
// Vínculo pendente ou ativo: 409 `already-linked`; recusado/revogado recomeça como pedido novo.
// Autorização ANTES de qualquer escrita (o upsert troca para o contexto do Hub por dentro): dono do Hub (404/403) e
// membro da organização (404). O vínculo do dono com a organização fica travado (FOR SHARE) até o COMMIT: se ele
// sair da organização ao mesmo tempo, o gancho de saída espera e então revoga o vínculo recém-criado.
// Locks: vínculo do dono com a organização -> Hub (FOR SHARE) -> linha do vínculo (FOR UPDATE).
@Injectable()
export class LinkHubOrganizationUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly orgAccess: OrganizationAccess,
    private readonly directory: OrganizationDirectory,
    private readonly hubs: HubRepository,
    private readonly links: HubOrganizationRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    input: { hubId: string; organizationId: string },
  ): Promise<HubLinkView> {
    const { hubId, organizationId } = input;
    const now = new Date();
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      await this.access.requireOwner(hubId, actor.userId);
      // Trava antes e confere depois: a leitura que vale é a feita com o lock.
      await this.directory.lockActiveMember(organizationId, actor.userId);
      await this.orgAccess.requireMember(organizationId, actor.userId);
      const policy = await currentLinkPolicy(this.directory, organizationId);
      if (!(await this.hubs.lockForShare(hubId))) throw hubNotFound();
      const existing = await this.links.lockForUpdate(hubId, organizationId);
      const link = HubOrganizationLink.ownerLinks({
        hubId,
        organizationId,
        userId: actor.userId,
        policy,
        now,
        existing,
      });
      await this.links.upsert(link);
      await this.audit.record({
        organizationId,
        userId: actor.userId,
        action: 'hub.organization.requested',
        metadata: { hubId, by: 'owner', status: link.status },
      });
      if (link.isActive) {
        await this.audit.record({
          organizationId,
          userId: actor.userId,
          action: 'hub.organization.approved',
          metadata: { hubId, as: 'owner', status: link.status },
        });
      }
      return toHubLinkView(link);
    });
  }
}
