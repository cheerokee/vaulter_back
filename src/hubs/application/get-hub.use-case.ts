import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { toHubWithRoleView, type HubWithRoleView } from './dto/hub-view.js';
import { HubAccess } from './hub-access.js';

// Detalhes do Hub (`GET /hubs/:id`): o dono e quem o vê por uma organização vinculada; os outros, 404.
@Injectable()
export class GetHubUseCase {
  constructor(private readonly access: HubAccess) {}

  async execute(actor: Actor, hubId: string): Promise<HubWithRoleView> {
    const { hub, role } = await this.access.requireAccess(hubId, actor.userId);
    return toHubWithRoleView(hub, role);
  }
}
