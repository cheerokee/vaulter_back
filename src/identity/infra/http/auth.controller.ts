import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthContext,
  CurrentAuth,
  Public,
} from '../../../shared/infra/http/auth.decorators.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { ThrottleByEmail } from '../../../shared/infra/http/throttling.decorators.js';
import type { ClientInfo } from '../../application/session-issuer.js';
import { LoginUseCase } from '../../application/login.use-case.js';
import { LogoutUseCase } from '../../application/logout.use-case.js';
import { PreLoginUseCase } from '../../application/pre-login.use-case.js';
import { RefreshSessionUseCase } from '../../application/refresh-session.use-case.js';
import { RegisterUserUseCase } from '../../application/register-user.use-case.js';
import { loginEmailTracker } from './login-email.tracker.js';
import { LoginDto } from './dto/login.dto.js';
import { LoginResponse } from './dto/login-response.dto.js';
import { PreLoginDto, PreLoginResponse } from './dto/pre-login.dto.js';
import { RefreshDto } from './dto/refresh.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { SessionTokensResponse } from './dto/session-tokens-response.dto.js';

function clientInfo(req: {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}): ClientInfo {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 500) : null,
  };
}

type Req = Parameters<typeof clientInfo>[0];

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly preLogin: PreLoginUseCase,
    private readonly register: RegisterUserUseCase,
    private readonly login: LoginUseCase,
    private readonly refresh: RefreshSessionUseCase,
    private readonly logout: LogoutUseCase,
  ) {}

  @Public()
  @Throttle({ default: RATE_LIMITS.prelogin })
  @Post('prelogin')
  @HttpCode(200)
  async doPreLogin(@Body() dto: PreLoginDto): Promise<PreLoginResponse> {
    return this.preLogin.execute({ email: dto.email });
  }

  @Public()
  @Throttle({ default: RATE_LIMITS.register })
  @Post('register')
  async doRegister(
    @Body() dto: RegisterDto,
    @Req() req: Req,
  ): Promise<LoginResponse> {
    const result = await this.register.execute({
      name: dto.name,
      email: dto.email,
      authProof: dto.authProof,
      kdfSalt: dto.kdfSalt,
      kdfParams: dto.kdfParams,
      publicKey: dto.publicKey,
      encryptedPrivateKey: dto.encryptedPrivateKey,
      device: { name: dto.device.name, platform: dto.device.platform },
      client: clientInfo(req),
    });
    return LoginResponse.from(result);
  }

  @Public()
  @Throttle({ default: RATE_LIMITS.loginIp })
  @ThrottleByEmail(loginEmailTracker)
  @Post('login')
  @HttpCode(200)
  async doLogin(
    @Body() dto: LoginDto,
    @Req() req: Req,
  ): Promise<LoginResponse> {
    const result = await this.login.execute({
      email: dto.email,
      authProof: dto.authProof,
      device: { name: dto.device.name, platform: dto.device.platform },
      client: clientInfo(req),
    });
    return LoginResponse.from(result);
  }

  @Public()
  @Throttle({ default: RATE_LIMITS.refresh })
  @Post('refresh')
  @HttpCode(200)
  async doRefresh(
    @Body() dto: RefreshDto,
    @Req() req: Req,
  ): Promise<SessionTokensResponse> {
    const tokens = await this.refresh.execute({
      refreshToken: dto.refreshToken,
      client: clientInfo(req),
    });
    return SessionTokensResponse.from(tokens);
  }

  @Post('logout')
  @HttpCode(204)
  async doLogout(@CurrentAuth() auth: AuthContext): Promise<void> {
    await this.logout.execute(auth);
  }
}
