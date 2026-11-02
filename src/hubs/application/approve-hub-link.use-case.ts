import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import { toHubLinkView, type HubLinkView } from './dto/hub-link-view.js';
import { HubAccess } from './hub-access.js';
import { hubLinkNotFound, hubNotFound } from './hub-errors.js';
import { resolveLinkDecider } from './link-decider.js';
import { currentLinkPolicy } from './link-policy.js';

// Aprovação do dono ou do admin (`POST /hubs/:id/organizations/:orgId/approve`, spec §4.6), conforme quem chama e o
// que falta; quem é as duas coisas dá os dois consentimentos. Sempre com a política ATUAL da organização, mesmo
// quando aquele lado já consentiu: se a organização passou a `any_member_hub`, o pedido pendente que já tinha o
// consentimento do dono se resolve na próxima aprovação (de qualquer um dos dois lados).
// Autorização antes (dono: 404 para quem não vê o Hub; senão `org.hubs.approve`: 404/403), depois Hub (FOR SHARE)
// -> vínculo (FOR UPDATE: dois aprovadores ao mesmo tempo não perdem o consentimento um do outro).
@Injectable()
export class ApproveHubLinkUseCase {
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
      const policy = await currentLinkPolicy(this.directory, organizationId);
      if (isOwner) link.approveAsOwner(actor.userId, now, policy);
      // O dono que também é admin: o consentimento da organização só se ainda faltar (já aprovado não é pendente).
      if (isAdmin && (!isOwner || link.status === 'pending')) {
        link.approveAsOrgAdmin(actor.userId, now, policy);
      }
      await this.links.upsert(link);
      await this.audit.record({
        organizationId,
        userId: actor.userId,
        action: 'hub.organization.approved',
        metadata: {
          hubId,
          as:
            isOwner && isAdmin
              ? 'owner_and_admin'
              : isOwner
                ? 'owner'
                : 'admin',
          status: link.status,
        },
      });
      return toHubLinkView(link);
    });
  }
}
