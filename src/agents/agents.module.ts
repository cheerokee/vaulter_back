import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HubDirectory } from '../hubs/application/hub-directory.js';
import { HubsModule } from '../hubs/hubs.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import {
  HubKindLookup,
  PcHubOnlyGuard,
} from '../shared/infra/http/pc-hub-only.guard.js';
import { AgentToolCatalog } from './application/agent-tool-catalog.js';
import { ListAgentToolsUseCase } from './application/list-agent-tools.use-case.js';
import { PublishAgentToolsUseCase } from './application/publish-agent-tools.use-case.js';
import { AgentToolRepository } from './domain/agent-tool.repository.js';
import { AgentToolTypeormEntity } from './infra/db/agent-tool.entity.js';
import { AgentToolTypeormRepository } from './infra/db/agent-tool.typeorm-repository.js';
import { AgentHubController } from './infra/http/agent-hub.controller.js';
import { AgentToolsController } from './infra/http/agent-tools.controller.js';

// O agente do PC (spec pc-agent). Depende de `hubs` e `organizations` só pelo que exportam (`HubAccess`, `HubDirectory`,
// `OrganizationAccess`); nunca importa `cloud`, e nenhum desses módulos importa `agents`.
@Module({
  imports: [
    HubsModule,
    OrganizationsModule,
    TypeOrmModule.forFeature([AgentToolTypeormEntity]),
  ],
  controllers: [AgentHubController, AgentToolsController],
  providers: [
    // Guard global de `@PcHubOnly()`: vem DEPOIS do HubsModule (precisa de `request.hub`) e ANTES do ThrottlingModule
    // (um Hub de outro tipo recebe o 404 antes de o throttler contar, como uma rota inexistente).
    { provide: APP_GUARD, useClass: PcHubOnlyGuard },
    { provide: HubKindLookup, useExisting: HubDirectory },
    { provide: AgentToolRepository, useClass: AgentToolTypeormRepository },
    AgentToolCatalog,
    PublishAgentToolsUseCase,
    ListAgentToolsUseCase,
  ],
  exports: [AgentToolCatalog],
})
export class AgentsModule {}
