import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { MembershipRepository } from '../domain/membership.repository.js';
import { OrganizationRepository } from '../domain/organization.repository.js';

// Consultas da organização exportadas para os outros módulos (junto com `OrganizationAccess` e `AuditLog`).
// Nenhuma lança para organização/usuário inexistente: quem chama decide o que fazer com `false`/`null`.
// NÃO é checagem de autorização: responde sobre qualquer organização, sem olhar quem pergunta. Quem chama já
// precisa ter passado pelo `OrganizationAccess` com o usuário que age (ex.: o Gestor que põe alguém no espaço).
// Ids malformados viram `false`/`null` antes do banco (nunca um 22P02 que chegaria como 500).
@Injectable()
export class OrganizationDirectory {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly orgs: OrganizationRepository,
  ) {}

  /** True only for an ACTIVE membership (a tombstoned one, a stranger or a malformed id is false). */
  async isActiveMember(orgId: string, userId: string): Promise<boolean> {
    if (!validate(orgId) || !validate(userId)) return false;
    return (await this.memberships.find(orgId, userId)) !== null;
  }

  /**
   * Locks the ACTIVE membership row (`FOR SHARE`) until the end of the transaction and tells whether it exists.
   * MUST run inside `UnitOfWork.run`. A concurrent removal from the organization waits for this transaction (and
   * then sees what it wrote); one that committed first makes this false. Malformed ids: false, no query.
   */
  async lockActiveMember(orgId: string, userId: string): Promise<boolean> {
    if (!validate(orgId) || !validate(userId)) return false;
    return this.memberships.lockActive(orgId, userId);
  }

  /**
   * Ids of every organization where the user is an ACTIVE member (reads only the user's own links, RLS
   * self_read). Used by `spaces` to resolve a space id for an org admin who is not in the space.
   */
  async organizationIdsOf(userId: string): Promise<string[]> {
    if (!validate(userId)) return [];
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.orgs.listForUser(userId, {
        ...(cursor ? { cursor } : {}),
        limit: 100,
      });
      ids.push(...page.items.map((i) => i.organization.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return ids;
  }

  /** The organization's recovery-kit public key, or null when none is registered (or the org is unknown). */
  async recoveryPublicKey(orgId: string): Promise<string | null> {
    if (!validate(orgId)) return null;
    // O repositório roda no contexto de RLS da organização.
    const org = await this.orgs.findById(orgId);
    return org?.recoveryPublicKey ?? null;
  }
}
