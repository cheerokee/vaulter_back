import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { HubAccess } from '../../hubs/application/hub-access.js';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { AgentToolDef } from '../domain/agent-tool.js';
import { AgentToolCatalog } from './agent-tool-catalog.js';
import { requireOwnedPcHub } from './pc-hub.js';

export type OrganizationAgentToolView = { name: string; title: string };

// Leituras do catálogo (spec pc-agent §5.4). Do dono: `GET /hubs/:id/agent/tools` (catálogo inteiro). Da organização:
// `GET /organizations/:orgId/agent/tools`, para o admin (`org.agents.manage`: 404 não membro, 403 sem a permissão) montar
// a ACL: nomes e títulos das ferramentas dos agentes com vínculo aprovado, juntos e sem repetir nome, e NUNCA de quem
// (nem o Hub nem o dono saem dali). O catálogo de cada Hub é lido no contexto dele, só depois da autorização.
@Injectable()
export class ListAgentToolsUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly directory: HubDirectory,
    private readonly orgAccess: OrganizationAccess,
    private readonly catalog: AgentToolCatalog,
    private readonly uow: UnitOfWork,
  ) {}

  ofHub(actor: Actor, hubId: string): Promise<AgentToolDef[]> {
    return this.uow.withContext({ userId: actor.userId }, async () => {
      await requireOwnedPcHub(this.access, this.directory, hubId, actor.userId);
      return this.catalog.toolsOf(hubId);
    });
  }

  ofOrganization(
    actor: Actor,
    organizationId: string,
  ): Promise<OrganizationAgentToolView[]> {
    return this.uow.withContext({ userId: actor.userId }, async () => {
      await this.orgAccess.requirePermission(
        organizationId,
        actor.userId,
        'org.agents.manage',
      );
      const byName = new Map<string, OrganizationAgentToolView>();
      for (const hubId of await this.directory.approvedHubIdsOf(
        organizationId,
      )) {
        for (const t of await this.catalog.toolsOf(hubId)) {
          if (!byName.has(t.name)) {
            byName.set(t.name, { name: t.name, title: t.title });
          }
        }
      }
      return [...byName.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    });
  }
}
