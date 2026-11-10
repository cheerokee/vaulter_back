import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { HubExecutorLostHooks } from '../../shared/application/hub-executor-lost-hooks.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceAccess } from '../../spaces/application/space-access.js';
import { SpaceRoomService } from '../../spaces/application/space-room.service.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { HubAccess } from './hub-access.js';
import { hubSpaceNotFound } from './hub-errors.js';

// Tira um espaço do Hub (`DELETE /hubs/:id/spaces/:spaceId`, spec §4.7): o dono tira qualquer um (o aparelho é dele);
// um Gestor tira o próprio espaço (404 para não membro do espaço, 403 para quem não é Gestor). Quem não vê o Hub:
// 404. O espaço sai também da Sala desse Hub (lápide no papel e nas cópias do Hub, troca de chave pendente) e o Hub
// deixa de ser executor dos assuntos desse espaço (gancho `HubExecutorLostHooks`, `space_removed_from_hub`).
// Locks: linha de hub_space (o UPDATE da lápide) -> espaço (FOR UPDATE, dentro do `revokeRoom`) -> assuntos (gancho).
@Injectable()
export class RemoveHubSpaceUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly spaceAccess: SpaceAccess,
    private readonly hubSpaces: HubSpaceRepository,
    private readonly room: SpaceRoomService,
    private readonly audit: AuditLog,
    private readonly executorLost: HubExecutorLostHooks,
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
      let organizationId: string;
      if (role === 'hub_owner') {
        const ref = await this.hubSpaces.find(hubId, spaceId);
        if (!ref) throw hubSpaceNotFound();
        organizationId = ref.organizationId;
      } else {
        const { space } = await this.spaceAccess.requireSpacePermission(
          spaceId,
          actor.userId,
          'space.members.manage',
        );
        organizationId = space.organizationId;
      }
      if (!(await this.hubSpaces.remove(hubId, spaceId, organizationId))) {
        throw hubSpaceNotFound();
      }
      const roomRevoked = await this.room.revokeRoom(
        { kind: 'trusted', organizationId, actorId: actor.userId },
        { hubId, spaceId, reason: 'space_removed_from_hub' },
      );
      await this.executorLost.run({
        hubId,
        spaceId,
        organizationId,
        reason: 'space_removed_from_hub',
        actorId: actor.userId,
        now: new Date(),
      });
      await this.audit.record({
        organizationId,
        userId: actor.userId,
        action: 'hub.space.removed',
        metadata: { hubId, spaceId, roomRevoked },
      });
    });
  }
}
