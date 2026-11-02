import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import {
  type CursorPage,
  type CursorPageRequest,
  decodeCursor,
  pageFrom,
} from '../../shared/domain/pagination.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import type { HubSpaceView } from './dto/hub-link-view.js';
import { HubAccess } from './hub-access.js';

// Espaços no Hub (`GET /hubs/:id/spaces`): o dono vê todos; quem vê o Hub por uma organização vinculada vê os das
// organizações de que é membro ativo (o conteúdo continua fechado: a chave só chega a quem está no espaço). Quem não
// vê o Hub: 404. Paginado por cursor em ordem de id do espaço; para quem não é dono, cada organização (lida no próprio
// escopo do RLS) devolve no máximo limit + 1 depois do cursor, e a página é a fusão ordenada.
@Injectable()
export class ListHubSpacesUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly directory: OrganizationDirectory,
    private readonly hubSpaces: HubSpaceRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    hubId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<HubSpaceView>> {
    const after = page.cursor ? decodeCursor(page.cursor) : undefined;
    const slice = { after, limit: page.limit + 1 };
    const key = (v: HubSpaceView) => v.spaceId;
    return this.uow.withContext({ userId: actor.userId }, async () => {
      const { role } = await this.access.requireAccess(hubId, actor.userId);
      if (role === 'hub_owner') {
        return pageFrom(
          await this.hubSpaces.list(hubId, slice),
          page.limit,
          key,
        );
      }
      const views: HubSpaceView[] = [];
      for (const orgId of await this.directory.organizationIdsOf(
        actor.userId,
      )) {
        views.push(
          ...(await this.hubSpaces.listInOrganization(hubId, orgId, slice)),
        );
      }
      views.sort((a, b) =>
        a.spaceId < b.spaceId ? -1 : a.spaceId > b.spaceId ? 1 : 0,
      );
      return pageFrom(views.slice(0, slice.limit), page.limit, key);
    });
  }
}
