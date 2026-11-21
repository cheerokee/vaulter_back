import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  CurrentHub,
  type HubAuthContext,
} from '../../../shared/infra/http/hub-auth.decorators.js';
import { hubIdTracker } from '../../../shared/infra/http/hub-id.tracker.js';
import { PcHubOnly } from '../../../shared/infra/http/pc-hub-only.guard.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { GetHubAgentPolicyUseCase } from '../../application/agent-policy.use-cases.js';
import { RecordAgentActionsUseCase } from '../../application/record-agent-actions.use-case.js';
import { PublishAgentToolsUseCase } from '../../application/publish-agent-tools.use-case.js';
import {
  RecordAgentActionsDto,
  toAgentActionItem,
} from './dto/agent-actions.dto.js';
import { PublishAgentToolsDto } from './dto/agent-tools.dto.js';

// Rotas do agente (token de Hub, só `pc`). Hub de outro tipo: o 404 do Nest para rota inexistente.
@ApiTags('agents')
@Controller('hub/agent')
export class AgentHubController {
  constructor(
    private readonly publish: PublishAgentToolsUseCase,
    private readonly policy: GetHubAgentPolicyUseCase,
    private readonly record: RecordAgentActionsUseCase,
  ) {}

  /**
   * The agent publishes its tool catalog; the new list replaces the previous one (up to 200 tools). The JSON body
   * limit of this route is `AGENT_TOOLS_BODY_MAX_BYTES` (2 MiB, `body-limits.ts`), not the 100 kB default.
   */
  @Throttle({
    default: { ...RATE_LIMITS.agentTools, getTracker: hubIdTracker },
  })
  @ApiBearerAuth()
  @PcHubOnly()
  @HttpCode(204)
  @Put('tools')
  async doPublish(
    @CurrentHub() hub: HubAuthContext,
    @Body() dto: PublishAgentToolsDto,
  ): Promise<void> {
    await this.publish.execute(hub, { tools: dto.tools });
  }

  /**
   * The policy of each approved organization for the owner of this agent: `{ items: [{ organizationId, version, rules }] }`,
   * only the `all` rules and the owner's own (never another person's). Version 0 and no rules when the organization
   * has no policy (deny by default). The agent reloads when the `agent_policy` item of `GET /hub/sync` moves.
   */
  @Throttle({
    default: { ...RATE_LIMITS.agentPolicyHub, getTracker: hubIdTracker },
  })
  @ApiBearerAuth()
  @PcHubOnly()
  @Get('policy')
  async doPolicy(@CurrentHub() hub: HubAuthContext) {
    return { items: await this.policy.execute(hub) };
  }

  /**
   * The agent reports what it did, in batches of up to 100 items `{ id, conversationId, messageId, toolName, effect,
   * decision, startedAt, durationMs, policyVersion }` (nothing else is accepted: no arguments, results, paths or URLs;
   * the organization is read by the server from the conversation). All or nothing: a conversation this Hub does not
   * execute is 404 `conversation-not-found` for the whole batch; the same id with the same content is a no-op, with
   * other content 409 `agent-action-id-conflict`. Answers `{ recorded }` (rows written by this call).
   */
  @Throttle({
    default: { ...RATE_LIMITS.agentActions, getTracker: hubIdTracker },
  })
  @ApiBearerAuth()
  @PcHubOnly()
  @HttpCode(200)
  @Post('actions')
  doRecord(
    @CurrentHub() hub: HubAuthContext,
    @Body() dto: RecordAgentActionsDto,
  ) {
    return this.record.execute(hub, dto.items.map(toAgentActionItem));
  }
}
