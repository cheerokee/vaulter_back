import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import { HubAccess } from './hub-access.js';
import { hubLinkNotFound, hubNotFound } from './hub-errors.js';
import { HubLinkCascade } from './hub-link-cascade.js';
import { HubPersonSessions } from './hub-person-sessions.js';
import { resolveLinkDecider } from './link-decider.js';

// Desvincular (`DELETE /hubs/:id/organizations/:orgId`, spec §4.6): o dono ou um admin da organização
// (`org.hubs.approve`), a qualquer momento, de um vínculo aprovado ou pendente (cancelar); senão 409
// `link-not-active`. Numa transação: Hub (FOR SHARE) -> vínculo (FOR UPDATE, segurado até o fim: a revogação da
// Sala depende disso) -> a cascata (`HubLinkCascade`: espaços da organização no Hub, Sala e cópias com troca
// pendente, papéis de Hub de quem ficou sem organização vinculada, auditoria) -> as sessões presas ao Hub de quem
// ficou sem papel nele caem (`HubPersonSessions.revokeLostAccess`, por último).
@Injectable()
export class UnlinkHubOrganizationUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly orgAccess: OrganizationAccess,
    private readonly hubs: HubRepository,
    private readonly links: HubOrganizationRepository,
    private readonly cascade: HubLinkCascade,
    private readonly personSessions: HubPersonSessions,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    input: { hubId: string; organizationId: string },
  ): Promise<void> {
    const { hubId, organizationId } = input;
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const { isOwner } = await resolveLinkDecider(
        this.access,
        this.orgAccess,
        hubId,
        organizationId,
        actor.userId,
      );
      // Quem não é dono não descobre se o Hub existe: Hub inexistente/desregistrado e Hub sem vínculo com a
      // organização dão o MESMO 404 `hub-link-not-found`.
      const notFound = isOwner ? hubNotFound : hubLinkNotFound;
      if (!(await this.hubs.lockForShare(hubId))) throw notFound();
      const link = await this.links.lockForUpdate(hubId, organizationId);
      if (!link) throw hubLinkNotFound();
      await this.cascade.unlink(link, {
        actorId: actor.userId,
        reason: 'unlinked',
      });
      await this.personSessions.revokeLostAccess([hubId]);
    });
  }
}
