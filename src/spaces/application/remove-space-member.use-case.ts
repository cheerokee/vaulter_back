import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceGrantRepository } from '../domain/space-grant.repository.js';
import { SpaceMembershipRules } from '../domain/space-membership.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { SpaceRepository } from '../domain/space.repository.js';
import { SpaceAccess } from './space-access.js';
import { lockSpaceMemberContext } from './space-member-lock.js';

// Tira alguém (Gestor): lápide nas cópias de todas as versões (o Hub apaga a cópia local) e no papel, e marca
// a troca de chave pendente. O último Gestor não sai enquanto houver outros membros.
@Injectable()
export class RemoveSpaceMemberUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly roles: SpaceRoleRepository,
    private readonly grants: SpaceGrantRepository,
    private readonly spaces: SpaceRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(actor: Actor, spaceId: string, userId: string): Promise<void> {
    return this.uow.run(async () => {
      const { space } = await this.access.lockAsMember(
        spaceId,
        actor.userId,
        'space.members.manage',
      );
      const { targetRole, ctx } = await lockSpaceMemberContext(
        this.roles,
        space,
        userId,
      );
      SpaceMembershipRules.assertCanRemove(targetRole, ctx);
      const orgId = space.organizationId;
      await this.grants.tombstoneUser(orgId, space.id, userId);
      await this.roles.remove(orgId, space.id, userId);
      space.markRotationRequired();
      await this.spaces.save(space);
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'space.member_removed',
        metadata: { spaceId: space.id, targetUserId: userId },
      });
    });
  }
}
