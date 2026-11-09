import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceAccess } from '../../spaces/application/space-access.js';
import { SpaceStorage } from '../../spaces/application/space-storage.js';
import { assertHubCapacityFits } from '../domain/hub-storage.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import type { HubSpaceView } from './dto/hub-link-view.js';
import { HubAccess } from './hub-access.js';
import {
  hubNotFound,
  organizationNotLinked,
  spaceNotFound,
} from './hub-errors.js';

// Põe um espaço no Hub (`POST /hubs/:id/spaces`, spec §4.7): o cérebro do espaço passa a morar ali.
// Quem: o dono do Hub, se for membro do espaço (qualquer papel), ou um Gestor do espaço (que vê o Hub por ser membro
// de uma organização vinculada). Quem não vê o Hub: 404 `hub-not-found`; não membro do espaço: 404
// `space-not-found`; membro sem ser Gestor (e sem ser dono): 403 (`SpaceAccess`). Só entra espaço de organização
// com vínculo aprovado: 422 `organization-not-linked` (a FK composta para hub_organization é a segunda trava).
// Capacidade (spec storage-backup §4.5): com capacidade informada, a soma dos tamanhos reservados dos espaços
// instalados (todas as organizações) + o novo cabe nela, senão 422 `hub-storage-full` com `missingBytes`; capacidade
// nula: sem conferência; espaço que já estava no Hub não conta de novo.
// Locks: Hub (FOR NO KEY UPDATE: duas instalações no mesmo Hub se serializam, e um aumento de espaço trava os Hubs
// dele) -> vínculo (FOR SHARE: um desvincular concorrente espera e então tira o espaço) -> hub_space vivo (FOR SHARE)
// -> espaço (FOR SHARE: um aumento em curso termina antes, e a soma usa o tamanho novo).
@Injectable()
export class AddHubSpaceUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly spaceAccess: SpaceAccess,
    private readonly spaceStorage: SpaceStorage,
    private readonly hubs: HubRepository,
    private readonly links: HubOrganizationRepository,
    private readonly hubSpaces: HubSpaceRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    input: { hubId: string; spaceId: string },
  ): Promise<HubSpaceView> {
    const { hubId, spaceId } = input;
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const { role } = await this.access.requireAccess(hubId, actor.userId);
      const { space } =
        role === 'hub_owner'
          ? await this.spaceAccess.requireSpaceMember(spaceId, actor.userId)
          : await this.spaceAccess.requireSpacePermission(
              spaceId,
              actor.userId,
              'space.members.manage',
            );
      const organizationId = space.organizationId;
      const hub = await this.hubs.lockForStorage(hubId);
      if (!hub) throw hubNotFound();
      const link = await this.links.lockForShare(hubId, organizationId);
      if (!link?.isActive) throw organizationNotLinked();
      const installed = await this.hubSpaces.lockForShare(
        hubId,
        space.id,
        organizationId,
      );
      const quotaBytes = await this.spaceStorage.lockQuota(
        organizationId,
        space.id,
      );
      if (quotaBytes === null) throw spaceNotFound();
      if (!installed && hub.storageCapacityBytes !== null) {
        assertHubCapacityFits(
          {
            capacityBytes: hub.storageCapacityBytes,
            reservedBytes: await this.hubSpaces.reservedBytes(hubId),
          },
          quotaBytes,
        );
      }
      const ref = {
        hubId,
        spaceId: space.id,
        organizationId,
        addedByUserId: actor.userId,
      };
      await this.hubSpaces.add(ref);
      await this.audit.record({
        organizationId,
        userId: actor.userId,
        action: 'hub.space.added',
        metadata: { hubId, spaceId: space.id },
      });
      // Lido no escopo da organização (um Gestor que não é dono não lê hub_space no próprio contexto): uma linha
      // que já estava viva fica com quem a pôs primeiro.
      const rows = await this.hubSpaces.listInOrganization(
        hubId,
        organizationId,
      );
      return rows.find((r) => r.spaceId === space.id) ?? ref;
    });
  }
}
