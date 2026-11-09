import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';

// Fatos sobre um Hub para os outros módulos (o `storage`), exportado. NÃO autoriza ninguém: quem chama já tem o Hub
// autenticado (token de Hub, `@CurrentHub()`), e a autorização do conteúdo é a Sala, conferida pelo `spaces`.
@Injectable()
export class HubDirectory {
  constructor(
    private readonly links: HubOrganizationRepository,
    private readonly uow: UnitOfWork,
  ) {}

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
