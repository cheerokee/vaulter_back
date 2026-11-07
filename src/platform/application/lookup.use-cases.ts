import { Injectable } from '@nestjs/common';
import { HubAdministration } from '../../hubs/application/hub-administration.js';
import type { HubAdministrationSummary } from '../../hubs/application/hub-administration.js';
import { UserDirectory } from '../../identity/application/user-directory.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import { OrganizationAdministration } from '../../organizations/application/organization-administration.js';
import type { OrganizationAdministrationSummary } from '../../organizations/application/organization-administration.js';
import { PlatformAccess } from './platform-access.js';
import { PlatformAudit } from './platform-audit.js';

export type UserLookup = { userId: string; name: string; email: string };

// Consultas do suporte (`platform.support.request`; 404 sem). Só leitura, sem nenhuma chave (a chave pública do
// usuário não sai). Não achar é 404. Toda consulta (achando ou não) vai para a trilha da plataforma
// (`platform.lookup.user|hub|organization`: rastro LGPD de quem da equipe olhou dado de cliente), com o alvo achado
// ou `metadata.found = false`; o e-mail procurado nunca é gravado (só o id da conta achada). Gravação avulsa, sem
// transação: é uma linha só e precisa ficar mesmo quando a resposta é 404.
@Injectable()
export class LookupUserUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly users: UserDirectory,
    private readonly audit: PlatformAudit,
  ) {}

  async execute(userId: string, email: string): Promise<UserLookup> {
    await this.access.require(userId, 'platform.support.request');
    const user = await this.users.findPublicByEmail(email);
    await this.audit.record({
      userId,
      action: 'platform.lookup.user',
      result: 'success',
      ...(user ? { targetUserId: user.id } : {}),
      metadata: { found: user !== null },
    });
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
    private readonly audit: PlatformAudit,
  ) {}

  async execute(
    userId: string,
    hubId: string,
  ): Promise<HubAdministrationSummary> {
    await this.access.require(userId, 'platform.support.request');
    const summary = await this.hubs.summary(hubId);
    await this.audit.record({
      userId,
      action: 'platform.lookup.hub',
      result: 'success',
      ...(summary
        ? { targetHubId: hubId, metadata: { found: true } }
        : { metadata: { found: false, hubId } }),
    });
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
    private readonly audit: PlatformAudit,
  ) {}

  async execute(
    userId: string,
    orgId: string,
  ): Promise<OrganizationAdministrationSummary> {
    await this.access.require(userId, 'platform.support.request');
    const summary = await this.orgs.summary(orgId);
    await this.audit.record({
      userId,
      action: 'platform.lookup.organization',
      result: 'success',
      ...(summary
        ? { targetOrganizationId: orgId, metadata: { found: true } }
        : { metadata: { found: false, organizationId: orgId } }),
    });
    if (!summary) {
      throw new NotFoundError(
        'organization-not-found',
        'The organization was not found.',
      );
    }
    return summary;
  }
}
