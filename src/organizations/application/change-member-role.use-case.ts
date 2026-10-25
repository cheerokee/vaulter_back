import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { DomainValidationError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import {
  MembershipRules,
  isOrgRoleKey,
  type OrgRoleKey,
} from '../domain/membership.js';
import { MembershipRepository } from '../domain/membership.repository.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import { RoleAssignmentRepository } from '../domain/role-assignment.repository.js';
import { AuditLog } from './audit-log.js';
import { lockMembershipContext } from './membership-guard.js';
import { OrganizationAccess } from './organization-access.js';

@Injectable()
export class ChangeMemberRoleUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly orgs: OrganizationRepository,
    private readonly memberships: MembershipRepository,
    private readonly roles: RoleAssignmentRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    orgId: string,
    userId: string,
    roleKey: string,
  ): Promise<{ userId: string; roleKey: OrgRoleKey }> {
    if (!isOrgRoleKey(roleKey)) {
      throw new DomainValidationError(
        'role-invalid',
        'The role must be org_admin or org_member.',
      );
    }
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
      MembershipRules.assertCanChangeRole(target, roleKey, ctx);
      if (target.roleKey === roleKey) return { userId, roleKey };
      await this.roles.assignOrgRole(orgId, userId, roleKey, actor.userId);
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'member.role_changed',
        metadata: { targetUserId: userId, from: target.roleKey, to: roleKey },
      });
      return { userId, roleKey };
    });
  }
}
