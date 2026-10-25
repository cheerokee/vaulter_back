import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { HubLinkPolicy } from '../domain/organization.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import { AuditLog } from './audit-log.js';
import {
  toOrganizationView,
  type OrganizationView,
} from './dto/organization-view.js';
import { loadOrganization } from './load-organization.js';
import { OrganizationAccess } from './organization-access.js';

export type UpdateOrganizationInput = {
  name?: string;
  hubLinkPolicy?: HubLinkPolicy;
};

@Injectable()
export class UpdateOrganizationUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly orgs: OrganizationRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    orgId: string,
    input: UpdateOrganizationInput,
  ): Promise<OrganizationView> {
    return this.uow.run(async () => {
      const membership = await this.access.requirePermission(
        orgId,
        actor.userId,
        'org.members.manage',
      );
      const org = await loadOrganization(this.orgs, orgId);
      const fields: string[] = [];
      if (input.name !== undefined) {
        org.rename(input.name);
        fields.push('name');
      }
      if (input.hubLinkPolicy !== undefined) {
        org.setHubLinkPolicy(input.hubLinkPolicy);
        fields.push('hubLinkPolicy');
      }
      if (fields.length > 0) {
        await this.orgs.save(org);
        // Só os nomes dos campos: o valor novo já está na organização.
        await this.audit.record({
          organizationId: orgId,
          userId: actor.userId,
          action: 'organization.updated',
          metadata: { fields },
        });
      }
      return toOrganizationView(org, membership.roleKey);
    });
  }
}
