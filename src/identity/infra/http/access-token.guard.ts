import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthenticatedError } from '../../../shared/domain/errors.js';
import {
  type AuthContext,
  IS_PUBLIC_KEY,
} from '../../../shared/infra/http/auth.decorators.js';
import { AuthenticateAccessTokenUseCase } from '../../application/authenticate-access-token.use-case.js';

const BEARER = /^Bearer ([^\s]+)$/;

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticate: AuthenticateAccessTokenUseCase,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      auth?: AuthContext;
    }>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? BEARER.exec(header) : null;
    if (!match) {
      throw new UnauthenticatedError(
        'invalid-access-token',
        'The access token is missing or malformed.',
      );
    }
    req.auth = await this.authenticate.execute(match[1]!, new Date());
    return true;
  }
}
