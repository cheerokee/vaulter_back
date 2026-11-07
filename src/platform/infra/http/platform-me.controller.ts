import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { GetPlatformMeUseCase } from '../../application/get-platform-me.use-case.js';
import { platformMeResponse } from './dto/responses.js';
import { RequireAnyPlatformRole } from './platform-permission.decorator.js';
import { PlatformPermissionGuard } from './platform-permission.guard.js';

@ApiTags('platform')
@UseGuards(PlatformPermissionGuard)
@Controller('platform/me')
export class PlatformMeController {
  constructor(private readonly getMe: GetPlatformMeUseCase) {}

  @ApiBearerAuth()
  @RequireAnyPlatformRole()
  @Get()
  async doGet(@CurrentAuth() auth: AuthContext) {
    return platformMeResponse(await this.getMe.execute(auth));
  }
}
