import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { MembershipRepository } from '../domain/membership.repository.js';
import { OrganizationRepository } from '../domain/organization.repository.js';

// Consultas da organização exportadas para os outros módulos (junto com `OrganizationAccess` e `AuditLog`).
// Nenhuma lança para organização/usuário inexistente: quem chama decide o que fazer com `false`/`null`.
@Injectable()
export class OrganizationDirectory {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly orgs: OrganizationRepository,
  ) {}

  /** True only for an ACTIVE membership (a tombstoned one, a stranger or a malformed id is false). */
  async isActiveMember(orgId: string, userId: string): Promise<boolean> {
    if (!validate(orgId)) return false;
    return (await this.memberships.find(orgId, userId)) !== null;
  }

  /** The organization's recovery-kit public key, or null when none is registered (or the org is unknown). */
  async recoveryPublicKey(orgId: string): Promise<string | null> {
    if (!validate(orgId)) return null;
    // O repositório roda no contexto de RLS da organização.
    const org = await this.orgs.findById(orgId);
    return org?.recoveryPublicKey ?? null;
  }
}
