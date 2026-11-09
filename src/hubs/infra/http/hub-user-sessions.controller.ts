import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { ThrottleByEmail } from '../../../shared/infra/http/throttling.decorators.js';
import { LoginPersonOnHubUseCase } from '../../application/login-person-on-hub.use-case.js';
import { HubPersonLoginDto } from './dto/hub.dto.js';
import { personLoginResponse } from './dto/responses.js';
import {
  CurrentHub,
  HubAuth,
  type HubAuthContext,
} from '../../../shared/infra/http/hub-auth.decorators.js';
import { hubIdTracker } from '../../../shared/infra/http/hub-id.tracker.js';
import { hubLoginEmailTracker } from './hub-login-email.tracker.js';

type Req = {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
};

// Rota interna do Hub (sem a tag `public`): só token de Hub. Login de uma pessoa feito pelo Hub (spec storage-backup
// §4.7), com sessão presa a ele.
@ApiTags('hubs')
@Controller('hub')
export class HubUserSessionsController {
  constructor(private readonly login: LoginPersonOnHubUseCase) {}

  /**
   * A person logs in on the hub: 200 with the same body as `/auth/login`. No role on the hub, wrong password or
   * unknown e-mail: the same 401 `invalid-credentials`. Limits per hub and per e-mail, like `/auth/login`.
   */
  @Throttle({
    default: { ...RATE_LIMITS.hubPersonLogin, getTracker: hubIdTracker },
  })
  @ThrottleByEmail(hubLoginEmailTracker)
  @ApiBearerAuth()
  @HubAuth()
  @HttpCode(200)
  @Post('user-sessions')
  async doLogin(
    @CurrentHub() hub: HubAuthContext,
    @Body() dto: HubPersonLoginDto,
    @Req() req: Req,
  ) {
    const ua = req.headers['user-agent'];
    return personLoginResponse(
      await this.login.execute(hub, {
        email: dto.email,
        authProof: dto.authProof,
        device: { name: dto.device.name },
        client: {
          ip: req.ip ?? null,
          userAgent: typeof ua === 'string' ? ua.slice(0, 500) : null,
        },
      }),
    );
  }
}
