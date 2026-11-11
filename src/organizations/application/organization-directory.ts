import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import type { HubLinkPolicy } from '../domain/organization.js';
import type { OrganizationStorageQuota } from '../domain/storage-quota.js';
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

  /**
   * Id of the user's personal organization (the one created at registration, where they are the owner), or null
   * for an unknown user or a malformed id (no query).
   */
  async personalOrganizationIdOf(userId: string): Promise<string | null> {
    if (!validate(userId)) return null;
    const org = await this.orgs.findPersonalOf(userId);
    return org?.id ?? null;
  }

  /** The organization's recovery-kit public key, or null when none is registered (or the org is unknown). */
  async recoveryPublicKey(orgId: string): Promise<string | null> {
    if (!validate(orgId)) return null;
    // O repositório roda no contexto de RLS da organização.
    const org = await this.orgs.findById(orgId);
    return org?.recoveryPublicKey ?? null;
  }

  /** How Hub links are approved in the organization; null for an unknown org or a malformed id. */
  async hubLinkPolicy(orgId: string): Promise<HubLinkPolicy | null> {
    if (!validate(orgId)) return null;
    const org = await this.orgs.findById(orgId);
    return org?.hubLinkPolicy ?? null;
  }

  /** Whether NEW room grants are allowed; false for an unknown org or a malformed id (deny by default). */
  async allowRoomSpaces(orgId: string): Promise<boolean> {
    if (!validate(orgId)) return false;
    const org = await this.orgs.findById(orgId);
    return org?.allowRoomSpaces ?? false;
  }

  /**
   * The cloud quota and the reserved sum of the live spaces; null for an unknown org or a malformed id. A plain
   * read (views): a check that reserves more must use `lockStorageQuota`.
   */
  async storageQuota(orgId: string): Promise<OrganizationStorageQuota | null> {
    if (!validate(orgId)) return null;
    const org = await this.orgs.findById(orgId);
    if (!org) return null;
    return {
      quotaBytes: org.storageQuotaBytes,
      reservedBytes: await this.orgs.reservedStorageBytes(orgId),
    };
  }

  /**
   * The organization's monthly AI budget (micro-USD); null for an unknown org or a malformed id. A plain read (views,
   * authorizing the cloud): a check that reserves spend must use `lockAiBudget`.
   */
  async aiBudget(orgId: string): Promise<bigint | null> {
    if (!validate(orgId)) return null;
    const org = await this.orgs.findById(orgId);
    return org?.aiBudgetMicroUsd ?? null;
  }

  /**
   * Same, with the organization row locked (`FOR NO KEY UPDATE`) until the end of the unit of work: AI reservations
   * (the `cloud` module) and budget changes serialize on it, so concurrent reservations never add up beyond the
   * budget. MUST run inside `UnitOfWork.run`. The organization row is a LEAF lock: take it after hubs and spaces, and
   * never hold it across a network call (reserve in a short transaction, call the model outside, settle in another).
   */
  async lockAiBudget(orgId: string): Promise<bigint | null> {
    if (!validate(orgId)) return null;
    const org = await this.orgs.lockForUpdate(orgId);
    return org?.aiBudgetMicroUsd ?? null;
  }

  /**
   * Same, with the organization row locked (`FOR NO KEY UPDATE`) until the end of the unit of work: creating or
   * growing a space (and changing the quota) serialize on it, so two reservations never both fit in the same room.
   * MUST run inside `UnitOfWork.run`. The organization row is a LEAF lock: take it after hubs and spaces.
   */
  async lockStorageQuota(
    orgId: string,
  ): Promise<OrganizationStorageQuota | null> {
    if (!validate(orgId)) return null;
    const org = await this.orgs.lockForUpdate(orgId);
    if (!org) return null;
    return {
      quotaBytes: org.storageQuotaBytes,
      reservedBytes: await this.orgs.reservedStorageBytes(orgId),
    };
  }
}
