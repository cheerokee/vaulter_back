import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { ListAgentToolsUseCase } from '../../application/list-agent-tools.use-case.js';
import { agentToolResponse } from './dto/agent-tools.dto.js';

// Leituras do catálogo para pessoas (token de usuário). Rotas internas do app, fora da doc pública.
@ApiTags('agents')
@Controller()
export class AgentToolsController {
  constructor(private readonly list: ListAgentToolsUseCase) {}

  /** The owner reads the catalog of their agent (404 `hub-not-found` for anyone else and for an appliance). */
  @ApiBearerAuth()
  @Get('hubs/:id/agent/tools')
  async doListOfHub(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
  ) {
    return { items: (await this.list.ofHub(auth, id)).map(agentToolResponse) };
  }

  /** Names and titles of the tools of the linked agents (never whose), for the admin who builds the ACL. */
  @ApiBearerAuth()
  @Get('organizations/:orgId/agent/tools')
  async doListOfOrganization(
    @CurrentAuth() auth: AuthContext,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
  ) {
    return { items: await this.list.ofOrganization(auth, orgId) };
  }
}
