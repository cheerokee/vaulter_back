import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import {
  toOrganizationView,
  type OrganizationView,
} from './dto/organization-view.js';
import { OrganizationAccess } from './organization-access.js';
import { loadOrganization } from './load-organization.js';

@Injectable()
export class GetOrganizationUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly orgs: OrganizationRepository,
  ) {}

  async execute(actor: Actor, orgId: string): Promise<OrganizationView> {
    const membership = await this.access.requireMember(orgId, actor.userId);
    const org = await loadOrganization(this.orgs, orgId);
    return toOrganizationView(org, membership.roleKey);
  }
}
