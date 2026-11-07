import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { ThrottleReauth } from '../../../shared/infra/http/throttling.decorators.js';
import { ChangePasswordUseCase } from '../../application/change-password.use-case.js';
import { ChangeRecoveryCodeUseCase } from '../../application/change-recovery-code.use-case.js';
import { GetMeUseCase } from '../../application/get-me.use-case.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { ChangeRecoveryCodeDto } from './dto/change-recovery-code.dto.js';
import { MeResponse } from './dto/me-response.dto.js';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(
    private readonly getMe: GetMeUseCase,
    private readonly changePassword: ChangePasswordUseCase,
    private readonly changeRecoveryCode: ChangeRecoveryCodeUseCase,
  ) {}

  @Get()
  async doGet(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return MeResponse.from(await this.getMe.execute(auth));
  }

  @ThrottleReauth()
  @Put('password')
  @HttpCode(204)
  async doChangePassword(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.changePassword.execute(auth, dto);
  }

  @ThrottleReauth()
  @Put('recovery-code')
  @HttpCode(204)
  async doChangeRecoveryCode(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: ChangeRecoveryCodeDto,
  ): Promise<void> {
    await this.changeRecoveryCode.execute(auth, dto);
  }
}
