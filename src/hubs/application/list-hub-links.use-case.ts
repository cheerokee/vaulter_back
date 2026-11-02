import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import {
  type CursorPage,
  type CursorPageRequest,
  decodeCursor,
  pageFrom,
} from '../../shared/domain/pagination.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { toHubLinkView, type HubLinkView } from './dto/hub-link-view.js';
import { HubAccess } from './hub-access.js';
import { hubNotFound, hubPermissionDenied } from './hub-errors.js';

// Vínculos e pedidos de um Hub (`GET /hubs/:id/organizations`): o dono vê todos (sem lápide); um admin
// (`org.hubs.approve`) vê os das organizações que administra, inclusive pendentes (é ele quem aprova, mesmo sem
// ainda ver o Hub). Quem vê o Hub sem administrar nenhuma organização com vínculo ou pedido: 403; os outros: 404.
// Paginado por cursor, em ordem de id da organização (um vínculo por organização). Para o admin, a autorização olha
// TODAS as organizações que ele administra, independente do cursor (uma página vazia depois do fim continua 200).
@Injectable()
export class ListHubLinksUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly orgAccess: OrganizationAccess,
    private readonly directory: OrganizationDirectory,
    private readonly links: HubOrganizationRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    hubId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<HubLinkView>> {
    const after = page.cursor ? decodeCursor(page.cursor) : undefined;
    const want = page.limit + 1;
    const key = (v: HubLinkView) => v.organizationId;
    return this.uow.withContext({ userId: actor.userId }, async () => {
      const grant = await this.access.find(hubId, actor.userId);
      if (grant?.role === 'hub_owner') {
        const rows = await this.links.list(hubId, { after, limit: want });
        return pageFrom(rows.map(toHubLinkView), page.limit, key);
      }
      const orgIds = [
        ...(await this.directory.organizationIdsOf(actor.userId)),
      ].sort();
      const views: HubLinkView[] = [];
      let administersALink = false;
      for (const orgId of orgIds) {
        if (administersALink && views.length >= want) break;
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
        if (!link) continue;
        administersALink = true;
        if ((after === undefined || orgId > after) && views.length < want) {
          views.push(toHubLinkView(link));
        }
      }
      if (administersALink) return pageFrom(views, page.limit, key);
      throw grant ? hubPermissionDenied() : hubNotFound();
    });
  }
}
