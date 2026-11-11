import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { aiBudgetState } from '../domain/ai-budget.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import {
  toOrganizationView,
  type OrganizationView,
} from './dto/organization-view.js';
import { OrganizationAccess } from './organization-access.js';
import { loadOrganization } from './load-organization.js';
import { OrganizationAiSpend } from './organization-ai-spend.js';

@Injectable()
export class GetOrganizationUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly orgs: OrganizationRepository,
    private readonly aiSpend: OrganizationAiSpend,
  ) {}

  async execute(actor: Actor, orgId: string): Promise<OrganizationView> {
    const membership = await this.access.requireMember(orgId, actor.userId);
    const org = await loadOrganization(this.orgs, orgId);
    return {
      ...toOrganizationView(org, membership.roleKey, new Date()),
      storage: {
        quotaBytes: org.storageQuotaBytes,
        reservedBytes: await this.orgs.reservedStorageBytes(orgId),
      },
      // Todo membro vê o ESTADO do orçamento de IA (o app explica por que a nuvem parou), nunca os valores: esses só
      // em `GET /organizations/:id/ai-usage`, com `org.billing`.
      ai: aiBudgetState(
        org.aiBudgetMicroUsd,
        await this.aiSpend.consumedMicroUsd(orgId),
      ),
    };
  }
}
