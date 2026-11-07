import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NotFoundError } from '../../../shared/domain/errors.js';
import type { AuthContext } from '../../../shared/infra/http/auth.decorators.js';
import { PlatformAccess } from '../../application/platform-access.js';
import {
  PLATFORM_PERMISSION_KEY,
  PLATFORM_ROUTES_KEY,
  type PlatformRequirement,
} from './platform-permission.decorator.js';

// Trava das rotas /platform/*. Guard GLOBAL (APP_GUARD do PlatformModule): roda depois do guard global de token
// (request.auth) e ANTES do throttler (PlatformModule antes do ThrottlingModule no AppModule), para quem não é da
// equipe receber o 404 sem nenhum cabeçalho X-RateLimit-* nem 429 (rota inexistente não passa pelo throttler).
// Rota sem metadado da plataforma fora de um controller @PlatformRoutes(): não faz nada. Confere a permissão no banco
// a cada requisição (sem cache). Sem a permissão: o MESMO 404 de rota inexistente (mesmo detail `Cannot GET /...`).
// Rota sem @RequirePlatformPermission/@RequireAnyPlatformRole num controller @PlatformRoutes() é erro de
// programação: falha fechada (500), nunca abre a rota.
@Injectable()
export class PlatformPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: PlatformAccess,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.get<PlatformRequirement | undefined>(
      PLATFORM_PERMISSION_KEY,
      context.getHandler(),
    );
    if (!requirement) {
      const isPlatformController = this.reflector.get<boolean | undefined>(
        PLATFORM_ROUTES_KEY,
        context.getClass(),
      );
      if (!isPlatformController) return true;
      throw new Error(
        `Platform route ${context.getClass().name}.${context.getHandler().name} has no platform requirement`,
      );
    }
    const request = context.switchToHttp().getRequest<{
      auth?: AuthContext;
      method: string;
      originalUrl: string;
    }>();
    const auth = request.auth;
    if (!auth) throw new Error('PlatformPermissionGuard needs request.auth');
    try {
      if (requirement === 'any-role') {
        await this.access.requireAnyRole(auth.userId);
      } else {
        await this.access.require(auth.userId, requirement);
      }
    } catch (err) {
      // Exactly what Nest answers for an unmatched route (RoutesResolver.registerNotFoundHandler, Express adapter:
      // method + originalUrl): the problem+json body cannot tell a hidden platform route from a nonexistent one.
      if (err instanceof NotFoundError) {
        throw new NotFoundException(
          `Cannot ${request.method} ${request.originalUrl}`,
        );
      }
      throw err;
    }
    return true;
  }
}
