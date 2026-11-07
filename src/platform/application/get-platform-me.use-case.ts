import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type {
  PlatformPermission,
  PlatformRoleKey,
} from '../domain/platform-catalog.js';
import { PlatformRoleRepository } from '../domain/platform-role.repository.js';
import { platformNotFound } from './platform-access.js';

export type PlatformMeView = {
  roles: PlatformRoleKey[];
  permissions: PlatformPermission[];
};

// O que a tela da equipe precisa saber da pessoa. Sem papel nenhum: 404 (como toda rota da plataforma).
@Injectable()
export class GetPlatformMeUseCase {
  constructor(private readonly roles: PlatformRoleRepository) {}

  async execute(actor: Actor): Promise<PlatformMeView> {
    const roles = await this.roles.rolesOf(actor.userId);
    if (roles.length === 0) throw platformNotFound();
    return { roles, permissions: await this.roles.permissionsOf(actor.userId) };
  }
}
