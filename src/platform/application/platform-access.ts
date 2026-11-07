import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../../shared/domain/errors.js';
import type { PlatformPermission } from '../domain/platform-catalog.js';
import { PlatformRoleRepository } from '../domain/platform-role.repository.js';

// Sem a permissão (ou sem papel nenhum), as rotas da plataforma respondem o mesmo 404 de rota inexistente: não
// revelam que existem (spec §4.2).
export function platformNotFound(): NotFoundError {
  return new NotFoundError('not-found', 'The resource was not found.');
}

// Trava da equipe: lê as atribuições no banco a cada chamada (sem cache), então retirar um papel vale na próxima
// requisição. Padrão para todo caso de uso da plataforma (o guard das rotas usa o mesmo serviço).
@Injectable()
export class PlatformAccess {
  constructor(private readonly roles: PlatformRoleRepository) {}

  /** Every permission of the user, or 404 `not-found` when `permission` is not among them. */
  async require(
    userId: string,
    permission: PlatformPermission,
  ): Promise<PlatformPermission[]> {
    const permissions = await this.roles.permissionsOf(userId);
    if (!permissions.includes(permission)) throw platformNotFound();
    return permissions;
  }

  async has(userId: string, permission: PlatformPermission): Promise<boolean> {
    return (await this.roles.permissionsOf(userId)).includes(permission);
  }

  /** Any platform role, even one without permissions (finance); 404 `not-found` otherwise. */
  async requireAnyRole(userId: string): Promise<void> {
    if (!(await this.roles.hasAnyRole(userId))) throw platformNotFound();
  }
}
