import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AuditLog } from '../../organizations/application/audit-log.js';
import {
  MemberRemovedHooks,
  type MemberRemovedContext,
} from '../../shared/application/member-removed-hooks.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubRoleRepository } from '../domain/hub-role.repository.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import { HubLinkCascade } from './hub-link-cascade.js';
import { HubPersonSessions } from './hub-person-sessions.js';

const LOCK_HOOK = 'hubs.member-removed.lock';
const CASCADE_HOOK = 'hubs.member-removed';
/** Before `spaces.member-removed` (order 0): hub, link and hub_space rows lock before any space. */
const LOCK_ORDER = -10;
/** After `spaces.member-removed`: the unlink cascade runs once the leaver's spaces are locked and their Room dropped. */
const CASCADE_ORDER = 10;

// Saída da organização (spec §6), dentro do unit of work da remoção/saída, depois da lápide do vínculo da pessoa;
// erro desfaz a saída inteira. Dois ganchos, em volta do gancho do `spaces`:
// 1. `order -10` (só trava): para cada vínculo vivo (pendente/aprovado) dos Hubs da pessoa com esta organização,
//    Hub (FOR SHARE) -> vínculo (FOR UPDATE) -> linhas de hub_space dessa organização (FOR UPDATE). Assim a ordem
//    global (Hub -> vínculo -> hub_space -> espaço) vale antes de o `spaces` travar os espaços.
// 2. o `spaces` trava TODOS os espaços da pessoa numa rodada só e emite a saída de cada espaço; o
//    `hubs.space-member-left` já tira a Sala desses espaços dentro dessa rodada.
// 3. `order +10`: desvincula com a cascata inteira (`HubLinkCascade`). A Sala da organização nesse Hub já está
//    vazia: só o dono que é Gestor libera na Sala (`GrantRoomUseCase`) e a liberação cai quando ele sai do espaço,
//    então todo espaço na Sala é um espaço da pessoa, já tratado em 2; `revokeRoomForOrganization` não trava uma
//    segunda rodada de espaços (sem risco de 40P01 aqui). Depois, lápide nos papéis de Hub de quem ficou sem
//    organização vinculada (no contexto do Hub), auditados como `hub.role.changed` nesta organização.
// 4. por último, as sessões presas aos Hubs tocados (os da pessoa desvinculados e os vinculados a esta organização)
//    de quem ficou sem papel neles caem (`HubPersonSessions.revokeLostAccess`, advisory em ordem de id do Hub).
@Injectable()
export class HubsMemberRemovedHook implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly hooks: MemberRemovedHooks,
    private readonly hubs: HubRepository,
    private readonly links: HubOrganizationRepository,
    private readonly hubSpaces: HubSpaceRepository,
    private readonly hubRoles: HubRoleRepository,
    private readonly cascade: HubLinkCascade,
    private readonly audit: AuditLog,
    private readonly personSessions: HubPersonSessions,
    private readonly uow: UnitOfWork,
  ) {}

  onModuleInit(): void {
    this.hooks.register({
      name: LOCK_HOOK,
      order: LOCK_ORDER,
      onMemberRemoved: (ctx) => this.lockOwnedLinks(ctx),
    });
    this.hooks.register({
      name: CASCADE_HOOK,
      order: CASCADE_ORDER,
      onMemberRemoved: (ctx) => this.onMemberRemoved(ctx),
    });
  }

  onModuleDestroy(): void {
    this.hooks.unregister(LOCK_HOOK);
    this.hooks.unregister(CASCADE_HOOK);
  }

  /** Phase 1: locks the owner's live links with the organization (and their hub_space rows); no write. */
  async lockOwnedLinks(ctx: MemberRemovedContext): Promise<void> {
    const { organizationId, userId } = ctx;
    for (const { hubId } of await this.links.listOwnedInOrganization(
      organizationId,
      userId,
    )) {
      if (!(await this.hubs.lockForShare(hubId))) continue;
      const link = await this.links.lockForUpdate(hubId, organizationId);
      if (!link || (link.status !== 'pending' && link.status !== 'approved')) {
        continue;
      }
      await this.hubSpaces.lockAllOfOrganization(hubId, organizationId);
    }
  }

  /** Phase 3: the unlink cascade for those links (locks already held), then hub roles without a linked org. */
  async onMemberRemoved(ctx: MemberRemovedContext): Promise<void> {
    const { organizationId, userId, actorId } = ctx;
    const owned = await this.links.listOwnedInOrganization(
      organizationId,
      userId,
    );
    for (const { hubId } of owned) {
      if (!(await this.hubs.lockForShare(hubId))) continue;
      const link = await this.links.lockForUpdate(hubId, organizationId);
      if (!link || (link.status !== 'pending' && link.status !== 'approved')) {
        continue;
      }
      await this.cascade.unlink(link, {
        actorId,
        reason: 'owner_left_organization',
      });
    }

    const approved =
      await this.links.listApprovedHubIdsOfOrganization(organizationId);
    for (const hubId of approved) {
      const removed = await this.uow.withContext({ hubId }, () =>
        this.hubRoles.removeUsersWithoutLinkedOrg(hubId),
      );
      for (const targetUserId of removed) {
        await this.audit.record({
          organizationId,
          userId: actorId,
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

    await this.personSessions.revokeLostAccess([
      ...owned.map((l) => l.hubId),
      ...approved,
    ]);
  }
}
