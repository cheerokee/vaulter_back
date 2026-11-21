import { Body, Controller, Get, Param, Put } from '@nestjs/common';
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
  GetAgentPolicyUseCase,
  ReplaceAgentPolicyUseCase,
} from '../../application/agent-policy.use-cases.js';
import { ReplaceAgentPolicyDto } from './dto/agent-policy.dto.js';

// Política de IA da organização para o agente do PC (spec pc-agent §5.5). Rotas internas do app, fora da doc pública.
@ApiTags('agents')
@Controller('organizations/:orgId/agent-policy')
export class AgentPolicyController {
  constructor(
    private readonly get: GetAgentPolicyUseCase,
    private readonly replace: ReplaceAgentPolicyUseCase,
  ) {}

  /** The whole current policy (`version` 0 and no rules when there is none). Every member; 404 for a non-member. */
  @Throttle({
    default: { ...RATE_LIMITS.agentPolicyRead, getTracker: userIdTracker },
  })
  @ApiBearerAuth()
  @Get()
  doGet(
    @CurrentAuth() auth: AuthContext,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
  ) {
    return this.get.execute(auth, orgId);
  }

  /**
   * Replaces the whole policy (`org.agents.manage`): 409 `agent-policy-version-stale` when `baseVersion` is not the
   * current one, 422 `agent-policy-invalid` (with `invalidRules`). The JSON body limit of this route is
   * `AGENT_POLICY_BODY_MAX_BYTES` (2 MiB, `body-limits.ts`): 500 rules do not fit in the 100 kB default.
   */
  @Throttle({
    default: { ...RATE_LIMITS.agentPolicyChange, getTracker: userIdTracker },
  })
  @ApiBearerAuth()
  @Put()
  doReplace(
    @CurrentAuth() auth: AuthContext,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
    @Body() dto: ReplaceAgentPolicyDto,
  ) {
    return this.replace.execute(auth, orgId, {
      baseVersion: dto.baseVersion,
      rules: dto.rules,
    });
  }
}
