import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import {
  SpaceMembershipRules,
  type SpaceRoleKey,
} from '../domain/space-membership.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { SpaceAccess } from './space-access.js';
import { lockSpaceMemberContext } from './space-member-lock.js';

// Troca o papel (Gestor). Espaço e Gestores travados: dois rebaixamentos concorrentes não deixam o espaço sem
// Gestor enquanto houver outros membros (`last-space-manager`).
@Injectable()
export class ChangeSpaceMemberRoleUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly roles: SpaceRoleRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    spaceId: string,
    userId: string,
    roleKey: string,
  ): Promise<{ userId: string; roleKey: SpaceRoleKey }> {
    const newRole = SpaceMembershipRules.assertSpaceRole(roleKey);
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
      SpaceMembershipRules.assertCanChangeRole(targetRole, newRole, ctx);
      if (targetRole === newRole) return { userId, roleKey: newRole };
      await this.roles.assign(
        space.organizationId,
        space.id,
        userId,
        newRole,
        actor.userId,
      );
      await this.audit.record({
        organizationId: space.organizationId,
        userId: actor.userId,
        action: 'space.member_role_changed',
        metadata: {
          spaceId: space.id,
          targetUserId: userId,
          from: targetRole,
          to: newRole,
        },
      });
      return { userId, roleKey: newRole };
    });
  }
}
