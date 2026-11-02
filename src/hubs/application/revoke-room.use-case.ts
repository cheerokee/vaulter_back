import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceRoomService } from '../../spaces/application/space-room.service.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { HubAccess } from './hub-access.js';
import { roomNotFound } from './hub-errors.js';

// Tira o espaço da Sala (`DELETE /hubs/:id/spaces/:spaceId/room`, spec §4.8): o dono do Hub (mesmo sem ser Gestor:
// o aparelho é dele; revogação `trusted` na organização do espaço no Hub) ou um Gestor do espaço (o `spaces` confere:
// 404 não membro, 403 não Gestor). Quem não vê o Hub: 404. Lápide no papel e nas cópias do Hub, troca de chave
// pendente. O espaço não estava na Sala: 404 `room-not-found`.
@Injectable()
export class RevokeRoomUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly hubSpaces: HubSpaceRepository,
    private readonly room: SpaceRoomService,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    input: { hubId: string; spaceId: string },
  ): Promise<void> {
    const { hubId, spaceId } = input;
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const { role } = await this.access.requireAccess(hubId, actor.userId);
      if (role !== 'hub_owner') {
        await this.room.revokeRoom(
          { kind: 'space_manager', userId: actor.userId },
          { hubId, spaceId, reason: 'revoked' },
        );
        return;
      }
      // A Sala só existe para espaço que está no Hub (tirar do Hub tira da Sala): a linha dá a organização.
      const ref = await this.hubSpaces.find(hubId, spaceId);
      const revoked =
        ref !== null &&
        (await this.room.revokeRoom(
          {
            kind: 'trusted',
            organizationId: ref.organizationId,
            actorId: actor.userId,
          },
          { hubId, spaceId, reason: 'revoked' },
        ));
      if (!revoked) throw roomNotFound();
    });
  }
}
