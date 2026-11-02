import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import { toHubLinkView, type HubLinkView } from './dto/hub-link-view.js';
import { HubAccess } from './hub-access.js';
import { hubLinkNotFound, hubNotFound } from './hub-errors.js';
import { resolveLinkDecider } from './link-decider.js';

// Recusa de um pedido pendente pelo dono ou por um admin (`POST /hubs/:id/organizations/:orgId/reject`). Mesma
// autorização e mesma ordem de locks da aprovação. Não pendente: 409 `link-not-pending`. Um pedido recusado pode
// recomeçar (vínculo do dono ou novo pedido por código).
@Injectable()
export class RejectHubLinkUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly orgAccess: OrganizationAccess,
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
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const { isOwner, isAdmin } = await resolveLinkDecider(
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
      link.reject();
      await this.links.upsert(link);
      await this.audit.record({
        organizationId,
        userId: actor.userId,
        action: 'hub.organization.rejected',
        metadata: {
          hubId,
          as:
            isOwner && isAdmin
              ? 'owner_and_admin'
              : isOwner
                ? 'owner'
                : 'admin',
        },
      });
      return toHubLinkView(link);
    });
  }
}
