import { Injectable } from '@nestjs/common';
import { HubAdministration } from '../../hubs/application/hub-administration.js';
import type { HubAdministrationSummary } from '../../hubs/application/hub-administration.js';
import { UserDirectory } from '../../identity/application/user-directory.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import { OrganizationAdministration } from '../../organizations/application/organization-administration.js';
import type { OrganizationAdministrationSummary } from '../../organizations/application/organization-administration.js';
import { PlatformAccess } from './platform-access.js';

export type UserLookup = { userId: string; name: string; email: string };

// Consultas do suporte (`platform.support.request`; 404 sem). Só leitura, sem nenhuma chave (a chave pública do
// usuário não sai). Não achar é 404.
@Injectable()
export class LookupUserUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly users: UserDirectory,
  ) {}

  async execute(userId: string, email: string): Promise<UserLookup> {
    await this.access.require(userId, 'platform.support.request');
    const user = await this.users.findPublicByEmail(email);
    if (!user) {
      throw new NotFoundError('user-not-found', 'The account was not found.');
    }
    return { userId: user.id, name: user.name, email: user.email };
  }
}

@Injectable()
export class LookupHubUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly hubs: HubAdministration,
  ) {}

  async execute(
    userId: string,
    hubId: string,
  ): Promise<HubAdministrationSummary> {
    await this.access.require(userId, 'platform.support.request');
    const summary = await this.hubs.summary(hubId);
    if (!summary) {
      throw new NotFoundError('hub-not-found', 'The hub was not found.');
    }
    return summary;
  }
}

@Injectable()
export class LookupOrganizationUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly orgs: OrganizationAdministration,
  ) {}

  async execute(
    userId: string,
    orgId: string,
  ): Promise<OrganizationAdministrationSummary> {
    await this.access.require(userId, 'platform.support.request');
    const summary = await this.orgs.summary(orgId);
    if (!summary) {
      throw new NotFoundError(
        'organization-not-found',
        'The organization was not found.',
      );
    }
    return summary;
  }
}
