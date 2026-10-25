import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { MembershipRepository } from '../domain/membership.repository.js';
import { Organization } from '../domain/organization.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import { RoleAssignmentRepository } from '../domain/role-assignment.repository.js';
import { AuditLog } from './audit-log.js';
import {
  toOrganizationView,
  type OrganizationView,
} from './dto/organization-view.js';

@Injectable()
export class CreateOrganizationUseCase {
  constructor(
    private readonly orgs: OrganizationRepository,
    private readonly memberships: MembershipRepository,
    private readonly roles: RoleAssignmentRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    input: { name: string },
  ): Promise<OrganizationView> {
    const now = new Date();
    const org = Organization.create({ name: input.name, now });
    await this.found(org, actor.userId, now);
    return toOrganizationView(org, 'org_admin');
  }

  /** Personal organization of a new account (registration hook): owner = admin, `personal_owner_user_id`. */
  async createPersonal(input: {
    ownerId: string;
    name: string;
    now: Date;
  }): Promise<Organization> {
    const org = Organization.createPersonal(input);
    await this.found(org, input.ownerId, input.now);
    return org;
  }

  // Organização, vínculo, papel de admin e auditoria na mesma transação.
  private async found(
    org: Organization,
    userId: string,
    now: Date,
  ): Promise<void> {
    await this.uow.run(async () => {
      await this.orgs.create(org);
      await this.memberships.add(org.id, userId, now);
      await this.roles.assignOrgRole(org.id, userId, 'org_admin', userId);
      await this.audit.record({
        organizationId: org.id,
        userId,
        action: 'organization.created',
        ...(org.isPersonal ? { metadata: { personal: true } } : {}),
      });
    });
  }
}
