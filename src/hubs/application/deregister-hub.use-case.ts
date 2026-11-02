import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceRoomService } from '../../spaces/application/space-room.service.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubRoleRepository } from '../domain/hub-role.repository.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import { HubAccess } from './hub-access.js';
import { hubNotFound } from './hub-errors.js';
import { ownerAuditOrganization } from './owner-audit.js';

// Desregistra o Hub (`DELETE /hubs/:id`, spec §6): só o dono (404/403). Numa transação, no contexto do dono:
// 1. trava a linha do Hub FOR UPDATE PRIMEIRO: serializa com `HubOrganizationRepository.upsert` (que a trava FOR
//    SHARE), então nenhum vínculo nasce ou revive para um Hub sendo desregistrado; e com toda mutação de vínculo,
//    espaço no Hub e Sala, que começam por `lockForShare` do Hub;
// 2. lápide em todos os vínculos vivos (pendente/aprovado viram revogado), organização por organização;
// 3. lápide nos espaços do Hub em TODAS as organizações a que ele já foi vinculado;
// 4. a Sala cai em todas essas organizações (vínculos revogados/recusados/com lápide inclusive: a linha da Sala fica
//    no RLS de cada organização), com lápide nas cópias do Hub e troca de chave pendente;
// 5. lápide em todas as atribuições do escopo do Hub, hub_owner e hub_room inclusive (só o contexto do dono alcança
//    as de sistema);
// 6. lápide no próprio Hub (o token de Hub passa a ser recusado) e `hub.deregistered` na organização pessoal do
//    dono; cada organização com vínculo vivo recebe `hub.organization.revoked`.
// Locks: Hub (FOR UPDATE) -> vínculos (em ordem de organização) -> hub_space -> espaços (em ordem de id, por
// organização).
@Injectable()
export class DeregisterHubUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly hubs: HubRepository,
    private readonly links: HubOrganizationRepository,
    private readonly hubSpaces: HubSpaceRepository,
    private readonly hubRoles: HubRoleRepository,
    private readonly room: SpaceRoomService,
    private readonly directory: OrganizationDirectory,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(actor: Actor, hubId: string): Promise<void> {
    const now = new Date();
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      await this.access.requireOwner(hubId, actor.userId);
      const hub = await this.hubs.lockForUpdate(hubId);
      if (!hub || hub.isDeregistered) throw hubNotFound();

      const everLinked = await this.links.listAllOrgIds(hubId);
      // Só os vínculos vivos pendentes/aprovados são revogados de fato (e auditados); recusados e já revogados só
      // ganham a lápide.
      const revokedOrgIds = (await this.links.list(hubId))
        .filter((l) => l.status === 'pending' || l.status === 'approved')
        .map((l) => l.organizationId);
      await this.links.tombstoneAllOfHub(hubId);
      const spaceIdsByOrg = new Map<string, string[]>();
      for (const organizationId of everLinked) {
        spaceIdsByOrg.set(
          organizationId,
          await this.hubSpaces.removeAllOfOrganization(hubId, organizationId),
        );
      }
      const roomSpaceIds = await this.room.revokeAllRoomForHub({
        hubId,
        actorId: actor.userId,
        reason: 'hub_deregistered',
        organizationIds: everLinked,
      });
      await this.hubRoles.removeAllOfHub(hubId);
      hub.deregister(now);
      await this.hubs.save(hub);

      for (const organizationId of revokedOrgIds) {
        await this.audit.record({
          organizationId,
          userId: actor.userId,
          action: 'hub.organization.revoked',
          metadata: {
            hubId,
            reason: 'hub_deregistered',
            spaceIds: spaceIdsByOrg.get(organizationId) ?? [],
          },
        });
      }
      await this.audit.record({
        organizationId: await ownerAuditOrganization(
          this.directory,
          hub.ownerUserId,
        ),
        userId: actor.userId,
        action: 'hub.deregistered',
        metadata: { hubId, organizationIds: revokedOrgIds, roomSpaceIds },
      });
    });
  }
}
