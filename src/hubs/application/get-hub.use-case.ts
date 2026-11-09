import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { toHubWithRoleView, type HubWithRoleView } from './dto/hub-view.js';
import { HubAccess } from './hub-access.js';

// Detalhes do Hub (`GET /hubs/:id`): o dono e quem o vê por uma organização vinculada; os outros, 404. Com a
// capacidade informada pelo Hub e o reservado pelos espaços instalados que quem consulta vê (como em
// `GET /hubs/:id/spaces`): o dono, todos; os outros, os das organizações de que são membros ativos.
@Injectable()
export class GetHubUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly directory: OrganizationDirectory,
    private readonly hubSpaces: HubSpaceRepository,
  ) {}

  async execute(actor: Actor, hubId: string): Promise<HubWithRoleView> {
    const { hub, role } = await this.access.requireAccess(hubId, actor.userId);
    const reservedBytes =
      role === 'hub_owner'
        ? await this.hubSpaces.reservedBytes(hub.id)
        : await this.hubSpaces.reservedBytes(
            hub.id,
            await this.directory.organizationIdsOf(actor.userId),
          );
    return {
      ...toHubWithRoleView(hub, role),
      storage: { capacityBytes: hub.storageCapacityBytes, reservedBytes },
    };
  }
}
