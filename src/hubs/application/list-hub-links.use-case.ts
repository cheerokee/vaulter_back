import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { toHubLinkView, type HubLinkView } from './dto/hub-link-view.js';
import { HubAccess } from './hub-access.js';
import { hubNotFound, hubPermissionDenied } from './hub-errors.js';

// Vínculos e pedidos de um Hub (`GET /hubs/:id/organizations`): o dono vê todos (sem lápide); um admin
// (`org.hubs.approve`) vê os das organizações que administra, inclusive pendentes (é ele quem aprova, mesmo sem
// ainda ver o Hub). Quem vê o Hub sem administrar nenhuma organização com vínculo ou pedido: 403; os outros: 404.
@Injectable()
export class ListHubLinksUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly orgAccess: OrganizationAccess,
    private readonly directory: OrganizationDirectory,
    private readonly links: HubOrganizationRepository,
    private readonly uow: UnitOfWork,
  ) {}

  execute(actor: Actor, hubId: string): Promise<HubLinkView[]> {
    return this.uow.withContext({ userId: actor.userId }, async () => {
      const grant = await this.access.find(hubId, actor.userId);
      if (grant?.role === 'hub_owner') {
        return (await this.links.list(hubId)).map(toHubLinkView);
      }
      const views: HubLinkView[] = [];
      for (const orgId of await this.directory.organizationIdsOf(
        actor.userId,
      )) {
        if (
          !(await this.orgAccess.hasPermission(
            orgId,
            actor.userId,
            'org.hubs.approve',
          ))
        ) {
          continue;
        }
        const link = await this.links.findInOrganization(hubId, orgId);
        if (link) views.push(toHubLinkView(link));
      }
      if (views.length > 0) return views;
      throw grant ? hubPermissionDenied() : hubNotFound();
    });
  }
}
