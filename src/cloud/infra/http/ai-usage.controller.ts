import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { userIdTracker } from '../../../shared/infra/http/user-id.tracker.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import {
  GetAiUsageUseCase,
  type AiUsageView,
} from '../../application/ai-usage.use-case.js';

// Uso de IA da organização no mês (spec active-cloud §4.4). Rota interna (tag `cloud`).
@ApiTags('cloud')
@Controller('organizations/:orgId/ai-usage')
export class AiUsageController {
  constructor(private readonly usage: GetAiUsageUseCase) {}

  /**
   * The month's AI budget, spend, reservations, warning level (0/75/90/100) and spend by space and kind. Needs
   * `org.billing` (org admins): 404 for a non-member, 403 without the permission.
   */
  @Throttle({
    default: { ...RATE_LIMITS.aiUsageRead, getTracker: userIdTracker },
  })
  @ApiBearerAuth()
  @Get()
  doGet(
    @CurrentAuth() auth: AuthContext,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
  ): Promise<AiUsageView> {
    return this.usage.execute(auth, orgId);
  }
}
