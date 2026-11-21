import { Body, Controller, HttpCode, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  CurrentHub,
  type HubAuthContext,
} from '../../../shared/infra/http/hub-auth.decorators.js';
import { hubIdTracker } from '../../../shared/infra/http/hub-id.tracker.js';
import { PcHubOnly } from '../../../shared/infra/http/pc-hub-only.guard.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { PublishAgentToolsUseCase } from '../../application/publish-agent-tools.use-case.js';
import { PublishAgentToolsDto } from './dto/agent-tools.dto.js';

// Rotas do agente (token de Hub, só `pc`). Hub de outro tipo: o 404 do Nest para rota inexistente.
@ApiTags('agents')
@Controller('hub/agent')
export class AgentHubController {
  constructor(private readonly publish: PublishAgentToolsUseCase) {}

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
}
