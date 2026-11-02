import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import { HubRoleRepository } from '../domain/hub-role.repository.js';
import { HubRoleRules, type AssignableHubRole } from '../domain/hub-roles.js';
import { HubAccess } from './hub-access.js';
import { hubNotFound, hubRoleTargetNotEligible } from './hub-errors.js';
import { ownerAuditOrganization } from './owner-audit.js';

// Papel de Hub de um membro (`PUT /hubs/:id/roles/:userId`, spec §6): só o dono (404/403), só `hub_operator` ou
// `hub_user` (422 `role-invalid`), nunca para o próprio dono (422 `hub-owner-protected`), e só para membro ativo de
// uma organização com vínculo aprovado (422 `user-not-in-linked-organization`). Uma linha de sistema no lugar dá
// 409 `hub-system-role` (repositório). O vínculo do alvo com a organização fica travado (FOR SHARE) até o COMMIT:
// se ele sair da organização ao mesmo tempo, o gancho de saída espera e então tira o papel recém-dado. Ordem de
// locks: Hub -> vínculo -> vínculo do alvo -> papel (um desvincular ou desregistro concorrente vence ou espera).
// Auditoria `hub.role.changed` na organização pessoal do dono (papel de Hub não é de organização; decisão 11).
@Injectable()
export class AssignHubRoleUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly directory: OrganizationDirectory,
    private readonly hubs: HubRepository,
    private readonly links: HubOrganizationRepository,
    private readonly hubRoles: HubRoleRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    input: { hubId: string; userId: string; roleKey: string },
  ): Promise<{ hubId: string; userId: string; roleKey: AssignableHubRole }> {
    const { hubId, userId } = input;
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const hub = await this.access.requireOwner(hubId, actor.userId);
      const roleKey = HubRoleRules.assertAssignable(input.roleKey);
      HubRoleRules.assertNotOwner(hub.ownerUserId, userId);
      if (!validate(userId)) throw hubRoleTargetNotEligible();
      // Hub (FOR SHARE: espera um desregistro) -> vínculo aprovado (FOR SHARE: espera um desvincular, que então
      // já tirou o vínculo e esta organização não conta) -> vínculo do alvo com a organização (FOR SHARE) -> papel.
      if (!(await this.hubs.lockForShare(hubId))) throw hubNotFound();
      let eligible = false;
      for (const orgId of await this.links.listActiveOrgIds(hubId)) {
        const link = await this.links.lockForShare(hubId, orgId);
        if (!link?.isActive) continue;
        if (await this.directory.lockActiveMember(orgId, userId)) {
          eligible = true;
          break;
        }
      }
      if (!eligible) throw hubRoleTargetNotEligible();
      await this.hubRoles.assign({ hubId, userId, roleKey });
      await this.audit.record({
        organizationId: await ownerAuditOrganization(
          this.directory,
          hub.ownerUserId,
        ),
        userId: actor.userId,
        action: 'hub.role.changed',
        metadata: { hubId, targetUserId: userId, roleKey },
      });
      return { hubId, userId, roleKey };
    });
  }
}
