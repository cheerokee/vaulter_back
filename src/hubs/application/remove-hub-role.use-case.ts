import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubRoleRepository } from '../domain/hub-role.repository.js';
import { HubRoleRules } from '../domain/hub-roles.js';
import { HubRepository } from '../domain/hub.repository.js';
import { HubAccess } from './hub-access.js';
import { hubNotFound } from './hub-errors.js';
import { HubPersonSessions } from './hub-person-sessions.js';
import { ownerAuditOrganization } from './owner-audit.js';

// Tira o papel de Hub explícito de um membro (`DELETE /hubs/:id/roles/:userId`): só o dono (404/403), nunca o dele
// (422 `hub-owner-protected`). Idempotente; a pessoa continua `hub_user` implícito enquanto for membro de uma
// organização vinculada. Auditado na organização pessoal do dono, só quando havia papel. Depois, as sessões presas
// ao Hub de quem ficou sem papel nenhum caem (`hub_access_lost`); hoje quem tem papel explícito é sempre membro de
// organização vinculada (segue `hub_user` implícito), então isso só pega o caso de uma invariante quebrada.
@Injectable()
export class RemoveHubRoleUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly directory: OrganizationDirectory,
    private readonly hubs: HubRepository,
    private readonly hubRoles: HubRoleRepository,
    private readonly audit: AuditLog,
    private readonly personSessions: HubPersonSessions,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    input: { hubId: string; userId: string },
  ): Promise<void> {
    const { hubId, userId } = input;
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const hub = await this.access.requireOwner(hubId, actor.userId);
      HubRoleRules.assertNotOwner(hub.ownerUserId, userId);
      // Mesma ordem das outras escritas de papel: o Hub primeiro (FOR SHARE).
      if (!(await this.hubs.lockForShare(hubId))) throw hubNotFound();
      if (!(await this.hubRoles.roleOf(hubId, userId))) return;
      await this.hubRoles.remove(hubId, userId);
      await this.audit.record({
        organizationId: await ownerAuditOrganization(
          this.directory,
          hub.ownerUserId,
        ),
        userId: actor.userId,
        action: 'hub.role.changed',
        metadata: { hubId, targetUserId: userId, roleKey: null },
      });
      await this.personSessions.revokeLostAccess([hubId]);
    });
  }
}
