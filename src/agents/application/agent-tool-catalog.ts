import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { AgentToolDef } from '../domain/agent-tool.js';
import { AgentToolRepository } from '../domain/agent-tool.repository.js';

// O catálogo publicado por um agente, exportado para as próximas peças (ACL, política, passo do cérebro). NÃO autoriza
// ninguém: quem chama já autorizou (dono, `org.agents.manage`) ou é o próprio agente. Lido no contexto do próprio Hub
// (`app.hub_id`), como `HubRepository.namesOf`.
@Injectable()
export class AgentToolCatalog {
  constructor(
    private readonly tools: AgentToolRepository,
    private readonly uow: UnitOfWork,
  ) {}

  /** Live tools of the hub by name; empty for an unknown hub or a hub that never published. */
  toolsOf(hubId: string): Promise<AgentToolDef[]> {
    if (!validate(hubId)) return Promise.resolve([]);
    return this.uow.withContext({ hubId }, () => this.tools.listOfHub(hubId));
  }
}
