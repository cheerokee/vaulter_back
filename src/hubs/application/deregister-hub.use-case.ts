import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubAccess } from './hub-access.js';
import { HubAdministration } from './hub-administration.js';

// Desregistra o Hub (`DELETE /hubs/:id`, spec §6): só o dono (404 para quem não vê, 403 para quem vê e não é dono).
// Numa transação, no contexto do dono: confere o dono e roda a cascata de `HubAdministration.deregister` (mesma
// ordem de locks e auditoria; o dono aparece como o usuário de cada linha de auditoria).
@Injectable()
export class DeregisterHubUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly administration: HubAdministration,
    private readonly uow: UnitOfWork,
  ) {}

  execute(actor: Actor, hubId: string): Promise<void> {
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      await this.access.requireOwner(hubId, actor.userId);
      await this.administration.deregister(hubId, {
        kind: 'user',
        userId: actor.userId,
      });
    });
  }
}
