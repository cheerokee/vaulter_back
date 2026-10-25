import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { MembershipRules } from '../domain/membership.js';
import { MembershipRepository } from '../domain/membership.repository.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import { RoleAssignmentRepository } from '../domain/role-assignment.repository.js';
import { AuditLog } from './audit-log.js';
import { lockMembershipContext } from './membership-guard.js';
import { OrganizationAccess } from './organization-access.js';

@Injectable()
export class RemoveMemberUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly orgs: OrganizationRepository,
    private readonly memberships: MembershipRepository,
    private readonly roles: RoleAssignmentRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(actor: Actor, orgId: string, userId: string): Promise<void> {
    return this.uow.run(async () => {
      const { target, ctx } = await lockMembershipContext(
        {
          access: this.access,
          orgs: this.orgs,
          memberships: this.memberships,
          roles: this.roles,
        },
        orgId,
        userId,
        { userId: actor.userId, permission: 'org.members.manage' },
      );
      MembershipRules.assertCanRemove(target, ctx);
      // Lápide no vínculo e na atribuição de papel da organização.
      await this.memberships.remove(orgId, userId);
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'member.removed',
        metadata: { targetUserId: userId },
      });
    });
  }
}
