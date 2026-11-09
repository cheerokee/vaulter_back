import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import {
  auditActorFields,
  type AuditActor,
} from '../../shared/application/audit-actor.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceRoomService } from '../../spaces/application/space-room.service.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubRoleRepository } from '../domain/hub-role.repository.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import { hubNotFound } from './hub-errors.js';
import { HubPersonSessions } from './hub-person-sessions.js';
import { ownerAuditOrganization } from './owner-audit.js';

/** What the platform team sees of a hub: no key, nothing encrypted. */
export type HubAdministrationSummary = {
  hubId: string;
  name: string;
  ownerUserId: string;
  deregistered: boolean;
  /** Organizations with an approved live link, in id order. */
  organizationIds: string[];
};

// Operações administrativas do Hub, exportadas (plano platform-roles): NÃO autorizam ninguém. Quem chama já decidiu
// que pode (o dono, pelo `DeregisterHubUseCase`, depois do `HubAccess.requireOwner`; a plataforma, pela permissão e
// pelo pedido de suporte dela). O `hubs` não conhece o módulo `platform`: a origem chega como `AuditActor` e vai para
// TODA gravação de auditoria (`auditActorFields`).
//
// Desregistro (spec hubs §6), numa transação:
// 0. descobre o dono lendo o Hub no contexto do próprio Hub (sem lock; a plataforma não vê o Hub pelo RLS) e roda o
//    resto no contexto do dono, o único que alcança as atribuições de sistema (hub_owner, hub_room);
// 1. trava a linha do Hub FOR UPDATE PRIMEIRO: serializa com `HubOrganizationRepository.upsert` (que a trava FOR
//    SHARE), então nenhum vínculo nasce ou revive para um Hub sendo desregistrado; e com toda mutação de vínculo,
//    espaço no Hub e Sala, que começam por `lockForShare` do Hub;
// 2. lápide em todos os vínculos vivos (pendente/aprovado viram revogado), organização por organização;
// 3. lápide nos espaços do Hub em TODAS as organizações a que ele já foi vinculado;
// 4. a Sala cai em todas essas organizações (vínculos revogados/recusados/com lápide inclusive: a linha da Sala fica
//    no RLS de cada organização), com lápide nas cópias do Hub e troca de chave pendente;
// 5. lápide em todas as atribuições do escopo do Hub, hub_owner e hub_room inclusive;
// 6. lápide no próprio Hub (o token de Hub passa a ser recusado) e `hub.deregistered` na organização pessoal do
//    dono; cada organização com vínculo vivo recebe `hub.organization.revoked`;
// 7. toda sessão de pessoa presa ao Hub cai (`hub_access_lost`, dono inclusive). Sem advisory: o login pelo Hub
//    segura o Hub FOR SHARE, que o FOR UPDATE do passo 1 serializa.
// Locks: Hub (FOR UPDATE) -> vínculos (em ordem de organização) -> hub_space -> espaços (em ordem de id, por
// organização). Hub inexistente, desregistrado ou id malformado: `hub-not-found`.
@Injectable()
export class HubAdministration {
  constructor(
    private readonly hubs: HubRepository,
    private readonly links: HubOrganizationRepository,
    private readonly hubSpaces: HubSpaceRepository,
    private readonly hubRoles: HubRoleRepository,
    private readonly room: SpaceRoomService,
    private readonly directory: OrganizationDirectory,
    private readonly audit: AuditLog,
    private readonly personSessions: HubPersonSessions,
    private readonly uow: UnitOfWork,
  ) {}

  deregister(hubId: string, actor: AuditActor): Promise<void> {
    if (!validate(hubId)) return Promise.reject(hubNotFound());
    const now = new Date();
    const origin = auditActorFields(actor);
    return this.uow.run(async () => {
      const found = await this.uow.withContext({ hubId }, () =>
        this.hubs.findById(hubId),
      );
      if (!found || found.isDeregistered) throw hubNotFound();
      const ownerUserId = found.ownerUserId;

      await this.uow.withContext({ userId: ownerUserId }, async () => {
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
          actorId: origin.userId,
          reason: 'hub_deregistered',
          organizationIds: everLinked,
          auditMetadata: origin.metadata,
        });
        await this.hubRoles.removeAllOfHub(hubId);
        hub.deregister(now);
        await this.hubs.save(hub);
        await this.personSessions.revokeAll(hubId);

        for (const organizationId of revokedOrgIds) {
          await this.audit.record({
            organizationId,
            userId: origin.userId,
            action: 'hub.organization.revoked',
            metadata: {
              ...origin.metadata,
              hubId,
              reason: 'hub_deregistered',
              spaceIds: spaceIdsByOrg.get(organizationId) ?? [],
            },
          });
        }
        await this.audit.record({
          organizationId: await ownerAuditOrganization(
            this.directory,
            ownerUserId,
          ),
          userId: origin.userId,
          action: 'hub.deregistered',
          metadata: {
            ...origin.metadata,
            hubId,
            organizationIds: revokedOrgIds,
            roomSpaceIds,
          },
        });
      });
    });
  }

  /** Read-only view of a hub (deregistered included), in the hub's own context; null when unknown or malformed. */
  async summary(hubId: string): Promise<HubAdministrationSummary | null> {
    if (!validate(hubId)) return null;
    return this.uow.withContext({ hubId }, async () => {
      const hub = await this.hubs.findById(hubId);
      if (!hub) return null;
      return {
        hubId: hub.id,
        name: hub.name,
        ownerUserId: hub.ownerUserId,
        deregistered: hub.isDeregistered,
        organizationIds: [...(await this.links.listActiveOrgIds(hubId))].sort(),
      };
    });
  }
}
