import { Injectable } from '@nestjs/common';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { assertAgentTools } from '../domain/agent-tool.js';
import { AgentToolRepository } from '../domain/agent-tool.repository.js';
import { pcHubNotFound } from './pc-hub.js';

// `PUT /hub/agent/tools` (spec pc-agent §5.4): o agente publica o que sabe fazer e a lista nova SUBSTITUI a anterior
// (lápide no que saiu, upsert do resto), num `uow.run`. Só `pc` (`@PcHubOnly()` já barrou os outros). Valida antes de
// abrir a transação; não registra o conteúdo em lugar nenhum.
@Injectable()
export class PublishAgentToolsUseCase {
  constructor(
    private readonly tools: AgentToolRepository,
    private readonly hubs: HubDirectory,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(hub: HubAuthContext, input: { tools: unknown[] }) {
    const tools = assertAgentTools(input.tools);
    const owner = await this.hubs.ownerOf(hub.hubId);
    if (!owner) throw pcHubNotFound();
    await this.uow.run(async () => {
      await this.uow.setContext({ hubId: hub.hubId });
      await this.tools.replaceAll(hub.hubId, owner, tools);
    });
  }
}
