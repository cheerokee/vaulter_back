import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { HubExecutorLostHooks } from '../../shared/application/hub-executor-lost-hooks.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceRoomService } from '../../spaces/application/space-room.service.js';
import type { HubOrganizationLink } from '../domain/hub-organization-link.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubRoleRepository } from '../domain/hub-role.repository.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';

export type UnlinkReason = 'unlinked' | 'owner_left_organization';

// Desvincular uma organização de um Hub (spec §4.6 e §6), compartilhado pela rota (dono ou admin) e pelo gancho de
// saída da organização (dono que sai). PRÉ-CONDIÇÃO, dentro do UnitOfWork.run de quem chama: o Hub travado FOR SHARE
// (`HubRepository.lockForShare`) e a linha do vínculo travada FOR UPDATE (`HubOrganizationRepository.lockForUpdate`),
// nessa ordem. A linha travada FOR UPDATE é o que torna `revokeRoomForOrganization` livre de deadlock: `grantRoom`
// passa pelo `confirmHubLink` (FOR SHARE nesta linha) antes de travar o espaço.
// Em ordem (Hub -> vínculo -> hub_space -> espaço -> assuntos):
// 1. o vínculo vira `revoked` (o Hub o recebe como lápide na sincronização);
// 2. lápide nos espaços dessa organização no Hub;
// 3. a Sala dessa organização cai: lápide no papel e nas cópias do Hub, troca de chave pendente; depois, o gancho
//    `HubExecutorLostHooks` (`organization_unlinked`): o `conversations` tira o Hub de executor dos assuntos dela;
// 4. lápide nos papéis de Hub de quem ficou sem nenhuma organização vinculada (no contexto do Hub, que só grava
//    lápide em papel atribuível);
// 5. auditoria na organização desvinculada (nenhuma leva cópia trancada).
@Injectable()
export class HubLinkCascade {
  constructor(
    private readonly links: HubOrganizationRepository,
    private readonly hubSpaces: HubSpaceRepository,
    private readonly hubRoles: HubRoleRepository,
    private readonly room: SpaceRoomService,
    private readonly audit: AuditLog,
    private readonly executorLost: HubExecutorLostHooks,
    private readonly uow: UnitOfWork,
  ) {}

  async unlink(
    link: HubOrganizationLink,
    input: { actorId: string | null; reason: UnlinkReason },
  ): Promise<void> {
    const { hubId, organizationId } = link;
    link.revoke();
    await this.links.upsert(link);
    const spaceIds = await this.hubSpaces.removeAllOfOrganization(
      hubId,
      organizationId,
    );
    const roomSpaceIds = await this.room.revokeRoomForOrganization({
      hubId,
      organizationId,
      actorId: input.actorId,
      reason: 'hub_unlinked',
    });
    await this.executorLost.run({
      hubId,
      organizationId,
      spaceId: null,
      reason: 'organization_unlinked',
      actorId: input.actorId,
      now: new Date(),
    });
    const usersWithoutLink = await this.uow.withContext({ hubId }, () =>
      this.hubRoles.removeUsersWithoutLinkedOrg(hubId),
    );
    await this.audit.record({
      organizationId,
      userId: input.actorId,
      action: 'hub.organization.revoked',
      metadata: { hubId, reason: input.reason, spaceIds, roomSpaceIds },
    });
    for (const spaceId of spaceIds) {
      await this.audit.record({
        organizationId,
        userId: input.actorId,
        action: 'hub.space.removed',
        metadata: { hubId, spaceId, reason: 'hub_unlinked' },
      });
    }
    for (const targetUserId of usersWithoutLink) {
      await this.audit.record({
        organizationId,
        userId: input.actorId,
        action: 'hub.role.changed',
        metadata: {
          hubId,
          targetUserId,
          roleKey: null,
          reason: 'no_linked_organization',
        },
      });
    }
  }
}
