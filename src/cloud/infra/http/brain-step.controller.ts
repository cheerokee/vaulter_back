import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  CurrentHub,
  type HubAuthContext,
} from '../../../shared/infra/http/hub-auth.decorators.js';
import { hubIdTracker } from '../../../shared/infra/http/hub-id.tracker.js';
import { PcHubOnly } from '../../../shared/infra/http/pc-hub-only.guard.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { BrainStepUseCase } from '../../application/brain/brain-step.use-case.js';
import type { BrainStepResponse } from '../../domain/brain-step.js';
import { BrainStepDto, toBrainStepRequest } from './dto/brain-step.dto.js';

// Passo do cérebro do agente do PC (spec pc-agent §5.3): só Hub `pc` (um aparelho recebe o 404 de rota inexistente,
// `@PcHubOnly()`), corpo JSON de até 256 KiB (`JSON_BODY_LIMITS`), 600/h por Hub. Rota interna (tag `cloud`).
@ApiTags('cloud')
@Controller('hub/conversations')
export class BrainStepController {
  constructor(private readonly brainStep: BrainStepUseCase) {}

  /**
   * One step of the agent's loop: the back checks the turn, the cloud, the term, the call limit and the sizes, then
   * answers `final`, `tools` (with each call's ACL effect) or `refused` (budget). A successful step renews the ack lease.
   */
  @Throttle({
    default: { ...RATE_LIMITS.brainStep, getTracker: hubIdTracker },
  })
  @ApiBearerAuth()
  @PcHubOnly()
  @Post(':id/brain/step')
  @HttpCode(200)
  async step(
    @CurrentHub() hub: HubAuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() body: BrainStepDto,
  ): Promise<BrainStepResponse> {
    return this.brainStep.execute(hub.hubId, id, toBrainStepRequest(body));
  }
}
