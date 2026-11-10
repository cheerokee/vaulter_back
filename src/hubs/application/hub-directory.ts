import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { HubRepository } from '../domain/hub.repository.js';

// Fatos sobre um Hub para os outros módulos (`storage`, `conversations`), exportado. NÃO autoriza ninguém: quem chama
// já tem o Hub autenticado (token de Hub, `@CurrentHub()`) ou já autorizou a pessoa; a autorização do conteúdo é do
// módulo que chama (a Sala no `spaces`, a participação no `conversations`).
@Injectable()
export class HubDirectory {
  constructor(
    private readonly hubs: HubRepository,
    private readonly links: HubOrganizationRepository,
    private readonly hubSpaces: HubSpaceRepository,
    private readonly uow: UnitOfWork,
  ) {}

  /** Owner of the hub (deregistered included), read in the hub's own context (no lock); null when unknown. */
  ownerOf(hubId: string): Promise<string | null> {
    if (!validate(hubId)) return Promise.resolve(null);
    return this.uow.withContext(
      { hubId, userId: '', organizationId: '' },
      async () => (await this.hubs.findById(hubId))?.ownerUserId ?? null,
    );
  }

  /**
   * Organization of a space installed on the hub (live `hub_space` of an APPROVED link: what the hub's own context
   * sees), or null. No lock; `lockExecutorCandidate` is the authoritative check.
   */
  installedSpaceOrganization(
    hubId: string,
    spaceId: string,
  ): Promise<string | null> {
    if (!validate(hubId) || !validate(spaceId)) return Promise.resolve(null);
    return this.uow.withContext(
      { hubId, userId: '', organizationId: '' },
      async () =>
        (await this.hubSpaces.find(hubId, spaceId))?.organizationId ?? null,
    );
  }

  /**
   * MUST run inside `UnitOfWork.run`. Whether the hub may execute work of the space (executor rule of the
   * conversations, spec conversations §4.1): an ACTIVE hub, an APPROVED live link with the space's organization and
   * the space installed (live `hub_space`). Locks in the global order, all FOR SHARE: Hub -> link -> hub_space, so a
   * concurrent deregistration, unlink or removal of the space waits for the caller's transaction (and then its
   * executor-lost hook sees what the caller wrote). The caller locks the space and its own rows only AFTER this.
   * Returns the hub owner, or null when any piece is missing (nothing to tell apart: the caller answers one error).
   */
  async lockExecutorCandidate(
    hubId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<{ ownerUserId: string } | null> {
    const hub = await this.hubs.lockForShare(hubId);
    if (!hub) return null;
    const link = await this.links.lockForShare(hubId, organizationId);
    if (!link?.isActive) return null;
    const installed = await this.hubSpaces.lockForShare(
      hubId,
      spaceId,
      organizationId,
    );
    return installed ? { ownerUserId: hub.ownerUserId } : null;
  }

  /**
   * Organizations with an approved, live link to the hub, in id order, read in the hub's own context (no lock).
   * Empty for a malformed id. Inside a unit of work it joins it (savepoint) and restores the context.
   */
  approvedOrganizationIds(hubId: string): Promise<string[]> {
    if (!validate(hubId)) return Promise.resolve([]);
    return this.uow.withContext({ hubId }, () =>
      this.links.listActiveOrgIds(hubId),
    );
  }
}
