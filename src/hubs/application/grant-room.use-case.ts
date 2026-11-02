import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import {
  SpaceRoomService,
  type GrantRoomInput,
} from '../../spaces/application/space-room.service.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import { HubAccess } from './hub-access.js';
import {
  hubNotFound,
  organizationNotLinked,
  spaceNotOnHub,
} from './hub-errors.js';

export type GrantRoomRequest = Omit<GrantRoomInput, 'confirmHubLink'>;

// Libera o espaço na Sala do Hub (`PUT /hubs/:id/spaces/:spaceId/room`, spec §4.8). Quem: o dono do Hub (404 para
// quem não vê o Hub, 403 para quem vê e não é dono), que precisa ser Gestor do espaço (404/403 do `SpaceAccess`,
// dentro do `grantRoom`). O app tranca TODAS as versões da chave para a `encryptionPublicKey` do Hub (a do
// `HubView`); o backend só valida o formato e guarda as cópias. Política da organização desligada: 422
// `room-not-allowed` (do `spaces`; liberar de novo um Hub que já está na Sala continua valendo).
// `confirmHubLink` roda depois da checagem de acesso e ANTES do lock do espaço: Hub (FOR SHARE) -> vínculo aprovado
// (FOR SHARE; desvincular segura essa linha FOR UPDATE antes de revogar a Sala) -> espaço no Hub (FOR SHARE; tirar o
// espaço do Hub espera, e então tira também a Sala). Sem vínculo aprovado: 422 `organization-not-linked`; espaço
// fora do Hub: 422 `space-not-on-hub`.
@Injectable()
export class GrantRoomUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly hubs: HubRepository,
    private readonly links: HubOrganizationRepository,
    private readonly hubSpaces: HubSpaceRepository,
    private readonly room: SpaceRoomService,
    private readonly uow: UnitOfWork,
  ) {}

  execute(actor: Actor, input: GrantRoomRequest) {
    const { hubId, spaceId } = input;
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      await this.access.requireOwner(hubId, actor.userId);
      return this.room.grantRoom(actor, {
        ...input,
        confirmHubLink: async (organizationId) => {
          if (!(await this.hubs.lockForShare(hubId))) throw hubNotFound();
          const link = await this.links.lockForShare(hubId, organizationId);
          if (!link?.isActive) throw organizationNotLinked();
          const onHub = await this.hubSpaces.lockForShare(
            hubId,
            spaceId,
            organizationId,
          );
          if (!onHub) throw spaceNotOnHub();
        },
      });
    });
  }
}
