import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthContext } from '../../../shared/infra/http/auth.decorators.js';
import { PlatformAccess } from '../../application/platform-access.js';
import {
  PLATFORM_PERMISSION_KEY,
  type PlatformRequirement,
} from './platform-permission.decorator.js';

// Trava das rotas /platform/*: roda depois do guard global de token (request.auth) e confere a permissão no banco a
// cada requisição (sem cache). Sem a permissão: 404 `not-found`, como rota inexistente. Rota sem
// @RequirePlatformPermission/@RequireAnyPlatformRole num controller com este guard é erro de programação: falha
// fechada (500), nunca abre a rota.
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
      throw new Error(
        `Platform route ${context.getClass().name}.${context.getHandler().name} has no platform requirement`,
      );
    }
    const auth = context
      .switchToHttp()
      .getRequest<{ auth?: AuthContext }>().auth;
    if (!auth) throw new Error('PlatformPermissionGuard needs request.auth');
    if (requirement === 'any-role') {
      await this.access.requireAnyRole(auth.userId);
    } else {
      await this.access.require(auth.userId, requirement);
    }
    return true;
  }
}
