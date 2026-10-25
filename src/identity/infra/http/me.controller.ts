import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { ChangePasswordUseCase } from '../../application/change-password.use-case.js';
import { GetMeUseCase } from '../../application/get-me.use-case.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { userIdTracker } from './user-id.tracker.js';
import { MeResponse } from './dto/me-response.dto.js';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(
    private readonly getMe: GetMeUseCase,
    private readonly changePassword: ChangePasswordUseCase,
  ) {}

  @Get()
  async doGet(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return MeResponse.from(await this.getMe.execute(auth));
  }

  @Throttle({
    default: { ...RATE_LIMITS.changePassword, getTracker: userIdTracker },
  })
  @Put('password')
  @HttpCode(204)
  async doChangePassword(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.changePassword.execute(auth, dto);
  }
}
