import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { assertHubName } from '../domain/hub.js';
import { HubRepository } from '../domain/hub.repository.js';
import { toHubWithRoleView, type HubWithRoleView } from './dto/hub-view.js';
import { HubAccess } from './hub-access.js';

// Renomeia o Hub (`PATCH /hubs/:id`): só o dono (404/403); nome de 1 a 255 caracteres (422 `hub-name-invalid`).
@Injectable()
export class RenameHubUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly hubs: HubRepository,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    input: { hubId: string; name: string },
  ): Promise<HubWithRoleView> {
    const name = assertHubName(input.name);
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const hub = await this.access.requireOwner(input.hubId, actor.userId);
      hub.rename(name);
      await this.hubs.save(hub);
      return toHubWithRoleView(hub, 'hub_owner');
    });
  }
}
