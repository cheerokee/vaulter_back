import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../../shared/infra/http/auth.decorators.js';
import { THROTTLE_GROUPS } from '../../../shared/infra/http/rate-limits.js';
import { ThrottleGroup } from '../../../shared/infra/http/throttling.decorators.js';
import { IssueHubChallengeUseCase } from '../../application/issue-hub-challenge.use-case.js';
import { IssueHubTokenUseCase } from '../../application/issue-hub-token.use-case.js';
import { HubChallengeDto, HubTokenDto } from './dto/hub.dto.js';

// Autenticação do aparelho (públicas; sem refresh: o Hub repete o desafio). Internas: sem a tag `public`.
@ApiTags('hubs')
@Controller('hub-auth')
export class HubAuthController {
  constructor(
    private readonly challenge: IssueHubChallengeUseCase,
    private readonly token: IssueHubTokenUseCase,
  ) {}

  /** Single-use challenge (60 s). An unknown or deregistered hub gets an indistinguishable decoy that never validates. */
  @Public()
  @ThrottleGroup(THROTTLE_GROUPS.hubAuth)
  @Post('challenge')
  @HttpCode(200)
  async doChallenge(@Body() dto: HubChallengeDto) {
    const r = await this.challenge.execute(dto.hubId);
    return { challenge: r.challenge, expiresAt: r.expiresAt.toISOString() };
  }

  /** Hub access token (`typ: hub+jwt`, 15 min). Every failure is the same 401 `hub-auth-failed`. */
  @Public()
  @ThrottleGroup(THROTTLE_GROUPS.hubAuth)
  @Post('token')
  @HttpCode(200)
  async doToken(@Body() dto: HubTokenDto) {
    const r = await this.token.execute({
      hubId: dto.hubId,
      challenge: dto.challenge,
      signature: dto.signature,
    });
    return { accessToken: r.token, expiresAt: r.expiresAt.toISOString() };
  }
}
