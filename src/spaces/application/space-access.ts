import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import {
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import type { Space } from '../domain/space.js';
import {
  hasSpacePermission,
  type SpacePermission,
  type SpaceRoleKey,
} from '../domain/space-membership.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { SpaceRepository } from '../domain/space.repository.js';

export type SpaceMembership = { space: Space; roleKey: SpaceRoleKey };
/** Organization permission keys accepted by `OrganizationAccess` (no import of another module's domain). */
export type OrgPermission = Parameters<OrganizationAccess['hasPermission']>[2];

function spaceNotFound(): NotFoundError {
  return new NotFoundError('space-not-found', 'The space was not found.');
}

function permissionDenied(): PermissionDeniedError {
  return new PermissionDeniedError(
    'permission-denied',
    'You do not have permission to perform this action.',
  );
}

// Checagem de acesso ao espaço, exportada para os próximos módulos (o equivalente do `OrganizationAccess`).
// As rotas recebem só o `spaceId`; a organização é descoberta assim:
// - Membro do espaço: `SpaceRoleRepository.findOrganizationOfMember` lê só as linhas de role_assignments da
//   própria pessoa (policy self_read, contexto `app.user_id`). Um espaço em que ela não está, ou de outra
//   organização, não resolve: 404 `space-not-found`, o mesmo para id inexistente ou malformado. Depois, no
//   escopo da organização encontrada, confere que ela ainda é membro ativo da organização, que o espaço existe
//   e lê o papel.
// - Operações só de admin (promover Gestor, reabrir pelo kit): o admin não está no espaço. Procura o espaço só
//   nas organizações em que ele é membro ativo E tem a permissão pedida (`OrganizationDirectory.organizationIdsOf`
//   + `OrganizationAccess.hasPermission`), cada busca no escopo de RLS daquela organização. Quem não tem a
//   permissão em nenhuma organização do espaço recebe 404 (não descobre que o id existe); só quem JÁ é membro
//   do espaço e não tem a permissão da organização recebe 403.
// Mutações: `lockAsMember` / `lockWithOrgPermission` rodam DENTRO do UnitOfWork.run. Primeiro a checagem sem
// lock (quem não é membro nunca trava linha), depois `SELECT ... FOR UPDATE` no espaço e a checagem de novo,
// a que vale, já com o lock.
@Injectable()
export class SpaceAccess {
  constructor(
    private readonly spaces: SpaceRepository,
    private readonly roles: SpaceRoleRepository,
    private readonly orgAccess: OrganizationAccess,
    private readonly directory: OrganizationDirectory,
  ) {}

  /** Non-member (even an org admin), unknown or another organization's space: 404 `space-not-found`. */
  async requireSpaceMember(
    spaceId: string,
    userId: string,
  ): Promise<SpaceMembership> {
    const orgId =
      validate(spaceId) && validate(userId)
        ? await this.roles.findOrganizationOfMember(spaceId, userId)
        : null;
    if (!orgId || !(await this.directory.isActiveMember(orgId, userId))) {
      throw spaceNotFound();
    }
    const space = await this.spaces.findById(orgId, spaceId);
    const roleKey = space
      ? await this.roles.roleOf(orgId, spaceId, userId)
      : null;
    if (!space || !roleKey) throw spaceNotFound();
    return { space, roleKey };
  }

  /** A member without `permission`: 403; a non-member: 404. */
  async requireSpacePermission(
    spaceId: string,
    userId: string,
    permission: SpacePermission,
  ): Promise<SpaceMembership> {
    const membership = await this.requireSpaceMember(spaceId, userId);
    if (!hasSpacePermission(membership.roleKey, permission)) {
      throw permissionDenied();
    }
    return membership;
  }

  /**
   * MUST run inside `UnitOfWork.run`. Non-locking pre-check, then locks the space row (`FOR UPDATE`) and
   * re-reads the actor's role under the lock (the authoritative check). Returns the LOCKED space.
   */
  async lockAsMember(
    spaceId: string,
    userId: string,
    permission?: SpacePermission,
  ): Promise<SpaceMembership> {
    const pre = permission
      ? await this.requireSpacePermission(spaceId, userId, permission)
      : await this.requireSpaceMember(spaceId, userId);
    const orgId = pre.space.organizationId;
    const space = await this.spaces.lockForUpdate(orgId, spaceId);
    const roleKey = space
      ? await this.roles.roleOf(orgId, spaceId, userId)
      : null;
    if (!space || !roleKey) throw spaceNotFound();
    if (permission && !hasSpacePermission(roleKey, permission)) {
      throw permissionDenied();
    }
    return { space, roleKey };
  }

  /** Admin-only operations: resolves the space through an organization where the user holds `permission`. */
  async requireOrgPermissionForSpace(
    spaceId: string,
    userId: string,
    permission: OrgPermission,
  ): Promise<Space> {
    if (!validate(spaceId) || !validate(userId)) throw spaceNotFound();
    const memberOrg = await this.roles.findOrganizationOfMember(
      spaceId,
      userId,
    );
    if (memberOrg && (await this.directory.isActiveMember(memberOrg, userId))) {
      const space = await this.spaces.findById(memberOrg, spaceId);
      if (space) {
        if (
          !(await this.orgAccess.hasPermission(memberOrg, userId, permission))
        ) {
          throw permissionDenied();
        }
        return space;
      }
    }
    for (const orgId of await this.directory.organizationIdsOf(userId)) {
      if (!(await this.orgAccess.hasPermission(orgId, userId, permission))) {
        continue;
      }
      const space = await this.spaces.findById(orgId, spaceId);
      if (space) return space;
    }
    throw spaceNotFound();
  }

  /** MUST run inside `UnitOfWork.run`: pre-check, lock, then the org permission again under the lock. */
  async lockWithOrgPermission(
    spaceId: string,
    userId: string,
    permission: OrgPermission,
  ): Promise<Space> {
    const pre = await this.requireOrgPermissionForSpace(
      spaceId,
      userId,
      permission,
    );
    const orgId = pre.organizationId;
    const space = await this.spaces.lockForUpdate(orgId, spaceId);
    if (!space) throw spaceNotFound();
    if (!(await this.orgAccess.hasPermission(orgId, userId, permission))) {
      throw permissionDenied();
    }
    return space;
  }
}
