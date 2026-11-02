import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import type { HubSpaceView } from './dto/hub-link-view.js';
import { HubAccess } from './hub-access.js';

// Espaços no Hub (`GET /hubs/:id/spaces`): o dono vê todos; quem vê o Hub por uma organização vinculada vê os das
// organizações de que é membro ativo (o conteúdo continua fechado: a chave só chega a quem está no espaço). Quem não
// vê o Hub: 404.
@Injectable()
export class ListHubSpacesUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly directory: OrganizationDirectory,
    private readonly hubSpaces: HubSpaceRepository,
    private readonly uow: UnitOfWork,
  ) {}

  execute(actor: Actor, hubId: string): Promise<HubSpaceView[]> {
    return this.uow.withContext({ userId: actor.userId }, async () => {
      const { role } = await this.access.requireAccess(hubId, actor.userId);
      if (role === 'hub_owner') return this.hubSpaces.list(hubId);
      const views: HubSpaceView[] = [];
      for (const orgId of await this.directory.organizationIdsOf(
        actor.userId,
      )) {
        views.push(...(await this.hubSpaces.listInOrganization(hubId, orgId)));
      }
      return views.sort((a, b) => a.spaceId.localeCompare(b.spaceId));
    });
  }
}
