import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubRoleRepository } from '../domain/hub-role.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import { toHubWithRoleView, type HubWithRoleView } from './dto/hub-view.js';

// Meus Hubs (`GET /hubs`): os que a pessoa tem como dona e os das organizações dela com vínculo aprovado, ativos,
// paginados por cursor (id). Cada um com o papel dela (spec §6: sem linha explícita, `hub_user`).
@Injectable()
export class ListHubsUseCase {
  constructor(
    private readonly hubs: HubRepository,
    private readonly roles: HubRoleRepository,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    page: CursorPageRequest,
  ): Promise<CursorPage<HubWithRoleView>> {
    return this.uow.withContext({ userId: actor.userId }, async () => {
      const result = await this.hubs.listForUser(actor.userId, page);
      const items: HubWithRoleView[] = [];
      for (const hub of result.items) {
        const role =
          hub.ownerUserId === actor.userId
            ? 'hub_owner'
            : ((await this.roles.roleOf(hub.id, actor.userId)) ?? 'hub_user');
        items.push(toHubWithRoleView(hub, role));
      }
      return { items, nextCursor: result.nextCursor };
    });
  }
}
