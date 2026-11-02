import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import {
  type CursorPage,
  type CursorPageRequest,
  decodeCursor,
  pageFrom,
} from '../../shared/domain/pagination.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { HubLinkStatus } from '../domain/hub-organization-link.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import {
  toHubLinkView,
  type OrganizationHubLinkView,
} from './dto/hub-link-view.js';

// Vínculos e pedidos de Hub de UMA organização (`GET /organizations/:orgId/hub-links`), para o admin que aprova
// (`org.hubs.approve`): é por aqui que ele descobre o `hubId` de um pedido pendente sob `admin_approved` (o pedido
// por código não devolve o id a quem pede, e o admin ainda não vê o Hub pelo RLS). Não membro: 404; membro sem a
// permissão: 403 (padrão `OrganizationAccess`). Lido no escopo da organização, por id do Hub (cursor), com filtro
// opcional de status. O nome do Hub vem de uma leitura confiável no contexto de cada Hub, só depois da autorização.
@Injectable()
export class ListOrganizationHubLinksUseCase {
  constructor(
    private readonly orgAccess: OrganizationAccess,
    private readonly links: HubOrganizationRepository,
    private readonly hubs: HubRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    organizationId: string,
    page: CursorPageRequest & { status?: HubLinkStatus },
  ): Promise<CursorPage<OrganizationHubLinkView>> {
    return this.uow.withContext({ userId: actor.userId }, async () => {
      await this.orgAccess.requirePermission(
        organizationId,
        actor.userId,
        'org.hubs.approve',
      );
      const after = page.cursor ? decodeCursor(page.cursor) : undefined;
      const rows = await this.links.listOfOrganization(organizationId, {
        status: page.status,
        after,
        limit: page.limit + 1,
      });
      const shown = rows.slice(0, page.limit);
      const names = await this.hubs.namesOf(shown.map((l) => l.hubId));
      return pageFrom(
        rows.map((l) => ({
          ...toHubLinkView(l),
          hubName: names.get(l.hubId) ?? null,
        })),
        page.limit,
        (v) => v.hubId,
      );
    });
  }
}
