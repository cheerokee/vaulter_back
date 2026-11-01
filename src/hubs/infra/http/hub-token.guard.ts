import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AuthenticateHubTokenUseCase,
  type HubAuthContext,
} from '../../application/authenticate-hub-token.use-case.js';
import { invalidHubToken } from '../../application/hub-auth-errors.js';
import { IS_HUB_AUTH_KEY } from './hub-auth.decorators.js';

const BEARER = /^Bearer ([^\s]+)$/i;

// Guard global (APP_GUARD do HubsModule): só age em rotas @HubAuth(); nas outras não faz nada (o guard de token
// de usuário cuida delas). Registrado antes do ThrottlingModule: o rate limit por Hub lê `request.hub`.
@Injectable()
export class HubTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticate: AuthenticateHubTokenUseCase,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isHubRoute = this.reflector.getAllAndOverride<boolean>(
      IS_HUB_AUTH_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!isHubRoute) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      hub?: HubAuthContext;
    }>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? BEARER.exec(header) : null;
    if (!match) throw invalidHubToken();
    req.hub = await this.authenticate.execute(match[1]!, new Date());
    return true;
  }
}
