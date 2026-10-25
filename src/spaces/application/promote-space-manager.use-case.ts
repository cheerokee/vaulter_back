import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { OrphanRules } from '../domain/orphan.js';
import type { SpaceRoleKey } from '../domain/space-membership.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { SpaceAccess } from './space-access.js';
import { spaceMemberNotFound } from './space-member-lock.js';

// Admin da organização (org.members.manage) promove um membro QUE JÁ ESTÁ no espaço a Gestor, quando o espaço
// ficou sem Gestor (decisão 11). Ele não entra no espaço nem recebe chave. Espaço e Gestores travados.
@Injectable()
export class PromoteSpaceManagerUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly roles: SpaceRoleRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    spaceId: string,
    userId: string,
  ): Promise<{ userId: string; roleKey: SpaceRoleKey }> {
    return this.uow.run(async () => {
      const space = await this.access.lockWithOrgPermission(
        spaceId,
        actor.userId,
        'org.members.manage',
      );
      const orgId = space.organizationId;
      const managers = await this.roles.lockSpaceManagers(orgId, space.id);
      OrphanRules.assertNoManager(managers.length);
      const targetRole = validate(userId)
        ? await this.roles.roleOf(orgId, space.id, userId)
        : null;
      if (!targetRole) throw spaceMemberNotFound();
      await this.roles.assign(
        orgId,
        space.id,
        userId,
        'space_manager',
        actor.userId,
      );
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'space.manager_promoted',
        metadata: { spaceId: space.id, targetUserId: userId },
      });
      return { userId, roleKey: 'space_manager' };
    });
  }
}
