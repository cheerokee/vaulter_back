import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import {
  CursorPaginationQuery,
  pageResponse,
} from '../../../shared/infra/http/cursor-pagination.query.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { ListAgentActionsUseCase } from '../../application/list-agent-actions.use-case.js';
import {
  agentActionResponse,
  OrganizationAgentActionsQuery,
} from './dto/agent-actions.dto.js';

// Leituras da auditoria das ações do agente (spec pc-agent §5.6), token de usuário. Rotas internas do app, fora da doc
// pública. O agente grava por `POST /hub/agent/actions` (`AgentHubController`).
@ApiTags('agents')
@Controller()
export class AgentActionsController {
  constructor(private readonly list: ListAgentActionsUseCase) {}

  /**
   * The audit of the agents of the organization, newest first (`org.agents.manage`: 404 non-member, 403 without it),
   * filtered by `userId` (the owner of the agent) and `hubId`, with a cursor.
   */
  @ApiBearerAuth()
  @Get('organizations/:orgId/agent-actions')
  async doListOfOrganization(
    @CurrentAuth() auth: AuthContext,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
    @Query() query: OrganizationAgentActionsQuery,
  ) {
    return pageResponse(
      await this.list.ofOrganization(auth, orgId, {
        userId: query.userId,
        hubId: query.hubId,
        cursor: query.cursor,
        limit: query.limit,
      }),
      agentActionResponse,
    );
  }

  /** The owner reads what their own agent did, in every organization (404 `hub-not-found` for anyone else). */
  @ApiBearerAuth()
  @Get('hubs/:id/agent/actions')
  async doListOfHub(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Query() query: CursorPaginationQuery,
  ) {
    return pageResponse(
      await this.list.ofHub(auth, id, {
        cursor: query.cursor,
        limit: query.limit,
      }),
      agentActionResponse,
    );
  }
}
