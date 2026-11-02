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
import { HubRepository } from '../domain/hub.repository.js';
import { HubLinkCascade } from './hub-link-cascade.js';

const HOOK_NAME = 'hubs.member-removed';
/** Before `spaces.member-removed` (order 0): the link rows are locked before any space (hub -> link -> space). */
const HOOK_ORDER = -10;

// Saída da organização (spec §6), dentro do unit of work da remoção/saída, depois da lápide do vínculo da pessoa;
// erro desfaz a saída inteira.
// 1. Dono que sai: cada vínculo vivo (pendente ou aprovado) dos Hubs dele com esta organização é desvinculado, com a
//    cascata inteira (`HubLinkCascade`: espaços da organização no Hub, Sala, papéis, auditoria). Hub (FOR SHARE) ->
//    vínculo (FOR UPDATE) -> hub_space -> espaços. Roda ANTES do gancho do `spaces` (que trava os espaços da
//    pessoa), para não travar um vínculo depois de um espaço.
// 2. Papéis de Hub explícitos: em cada Hub com vínculo aprovado com esta organização, viram lápide os de quem não é
//    mais membro ativo de nenhuma organização vinculada (no contexto do Hub, que só grava lápide em papel
//    atribuível). Auditados como `hub.role.changed` nesta organização.
@Injectable()
export class HubsMemberRemovedHook implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly hooks: MemberRemovedHooks,
    private readonly hubs: HubRepository,
    private readonly links: HubOrganizationRepository,
    private readonly hubRoles: HubRoleRepository,
    private readonly cascade: HubLinkCascade,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  onModuleInit(): void {
    this.hooks.register({
      name: HOOK_NAME,
      order: HOOK_ORDER,
      onMemberRemoved: (ctx) => this.onMemberRemoved(ctx),
    });
  }

  onModuleDestroy(): void {
    this.hooks.unregister(HOOK_NAME);
  }

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

    for (const hubId of await this.links.listApprovedHubIdsOfOrganization(
      organizationId,
    )) {
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
  }
}
