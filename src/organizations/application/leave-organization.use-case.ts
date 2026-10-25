import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { MemberRemovedHooks } from '../../shared/application/member-removed-hooks.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { InvitationRepository } from '../domain/invitation.repository.js';
import { MembershipRules } from '../domain/membership.js';
import { MembershipRepository } from '../domain/membership.repository.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import { RoleAssignmentRepository } from '../domain/role-assignment.repository.js';
import { AuditLog } from './audit-log.js';
import { revokeInvitationsOfCreator } from './creator-invitations.js';
import { lockMembershipContext } from './membership-guard.js';
import { OrganizationAccess } from './organization-access.js';

@Injectable()
export class LeaveOrganizationUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly orgs: OrganizationRepository,
    private readonly memberships: MembershipRepository,
    private readonly roles: RoleAssignmentRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly invitations: InvitationRepository,
    private readonly memberRemovedHooks: MemberRemovedHooks,
  ) {}

  execute(actor: Actor, orgId: string): Promise<void> {
    return this.uow.run(async () => {
      const { ctx } = await lockMembershipContext(
        {
          access: this.access,
          orgs: this.orgs,
          memberships: this.memberships,
          roles: this.roles,
        },
        orgId,
        actor.userId,
        { userId: actor.userId },
      );
      MembershipRules.assertCanLeave(ctx);
      await this.memberships.remove(orgId, actor.userId);
      const now = new Date();
      // Módulos dependentes (ex.: espaços) reagem à saída, na mesma transação: se um falhar, a pessoa não sai.
      await this.memberRemovedHooks.run({
        organizationId: orgId,
        userId: actor.userId,
        actorId: actor.userId,
        reason: 'left',
        now,
      });
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'member.left',
      });
      await revokeInvitationsOfCreator(
        { invitations: this.invitations, audit: this.audit },
        orgId,
        actor.userId,
        actor.userId,
        now,
      );
    });
  }
}
