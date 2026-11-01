import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { SpaceMemberLeftHooks } from '../../shared/application/space-member-left-hooks.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceGrantRepository } from '../domain/space-grant.repository.js';
import { SpaceMembershipRules } from '../domain/space-membership.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { SpaceRepository } from '../domain/space.repository.js';
import { SpaceAccess } from './space-access.js';
import { lockSpaceMemberContext } from './space-member-lock.js';

// Sai do espaço (qualquer membro). Mesmo efeito de "tirar"; quem é o único membro pode sair (o espaço fica
// órfão e só reabre pelo kit).
@Injectable()
export class LeaveSpaceUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly roles: SpaceRoleRepository,
    private readonly grants: SpaceGrantRepository,
    private readonly spaces: SpaceRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly leftHooks: SpaceMemberLeftHooks,
  ) {}

  execute(actor: Actor, spaceId: string): Promise<void> {
    return this.uow.run(async () => {
      const { space } = await this.access.lockAsMember(spaceId, actor.userId);
      const { targetRole, ctx } = await lockSpaceMemberContext(
        this.roles,
        space,
        actor.userId,
      );
      SpaceMembershipRules.assertCanLeave(targetRole, ctx);
      const orgId = space.organizationId;
      await this.grants.tombstoneUser(orgId, space.id, actor.userId);
      await this.roles.remove(orgId, space.id, actor.userId);
      space.markRotationRequired();
      await this.spaces.save(space);
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'space.member_left',
        metadata: { spaceId: space.id },
      });
      // Quem reage à saída do espaço (ex.: `hubs` tira o espaço da Sala dos Hubs da pessoa) roda nesta transação;
      // erro desfaz a saída.
      await this.leftHooks.run({
        organizationId: orgId,
        spaceId: space.id,
        userId: actor.userId,
        now: new Date(),
      });
    });
  }
}
