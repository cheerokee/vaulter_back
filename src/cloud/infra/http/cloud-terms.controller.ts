import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { userIdTracker } from '../../../shared/infra/http/user-id.tracker.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import {
  AcceptCloudTermsUseCase,
  GetCloudTermsUseCase,
} from '../../application/cloud-terms.use-cases.js';
import {
  AcceptCloudTermsDto,
  acceptanceResponse,
  cloudTermsResponse,
} from './dto/cloud.dto.js';

// Termo da nuvem ativa por organização (spec active-cloud §4.1). Rotas internas (tag `cloud`).
@ApiTags('cloud')
@Controller('organizations/:orgId/cloud/terms')
export class CloudTermsController {
  constructor(
    private readonly getTerms: GetCloudTermsUseCase,
    private readonly accept: AcceptCloudTermsUseCase,
  ) {}

  /** The current term and the organization's latest acceptance (any member). */
  @ApiBearerAuth()
  @Get()
  async doGet(
    @CurrentAuth() auth: AuthContext,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
  ) {
    return cloudTermsResponse(await this.getTerms.execute(auth, orgId));
  }

  /** Whoever decides accepts the version + hash shown; 200 with the acceptance (the same one when repeated). */
  @Throttle({
    default: { ...RATE_LIMITS.cloudTermsAccept, getTracker: userIdTracker },
  })
  @ApiBearerAuth()
  @Post('accept')
  @HttpCode(200)
  async doAccept(
    @CurrentAuth() auth: AuthContext,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
    @Body() dto: AcceptCloudTermsDto,
    @Req() req: Request,
  ) {
    return acceptanceResponse(
      await this.accept.execute(auth, orgId, {
        version: dto.version,
        hash: dto.hash,
        ip: req.ip ?? null,
      }),
    );
  }
}
