import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { ConflictError, NotFoundError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { KeyRotationRules } from '../domain/key-rotation.js';
import { PendingGrantRepository } from '../domain/pending-grant.repository.js';
import { SpaceGrantRepository } from '../domain/space-grant.repository.js';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import {
  SpaceMembershipRules,
  type SpaceRoleKey,
} from '../domain/space-membership.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { assertWrappedKeys, type VersionGrantInput } from './dto/key-inputs.js';
import { SpaceAccess } from './space-access.js';

export type AddSpaceMemberInput = {
  userId: string;
  roleKey: string;
  /** The key of EVERY existing version, wrapped for the new member. */
  grants: VersionGrantInput[];
};

// Põe alguém no espaço (Gestor; decisão 7). O espaço fica travado do começo ao fim: uma troca de chave
// concorrente espera, e a pessoa nunca fica sem a versão nova. O admin da organização fora do espaço não passa
// do SpaceAccess (404): não põe ninguém, nem a si mesmo.
@Injectable()
export class AddSpaceMemberUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly directory: OrganizationDirectory,
    private readonly keys: SpaceKeyRepository,
    private readonly grants: SpaceGrantRepository,
    private readonly roles: SpaceRoleRepository,
    private readonly pending: PendingGrantRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    spaceId: string,
    input: AddSpaceMemberInput,
  ): Promise<{ userId: string; roleKey: SpaceRoleKey }> {
    const roleKey = SpaceMembershipRules.assertSpaceRole(input.roleKey);
    assertWrappedKeys(input.grants.map((g) => g.wrappedKey));
    return this.uow.run(async () => {
      // Só membro ativo da organização entra num espaço dela. O vínculo do alvo é travado (FOR SHARE) depois da
      // checagem de acesso de quem age e ANTES do espaço — a mesma ordem da saída da organização (vínculo, depois
      // espaços): uma saída concorrente espera esta transação (e o gancho dela desfaz a entrada), ou, se já
      // confirmou, o lock responde false.
      const { space } = await this.access.lockAsMember(
        spaceId,
        actor.userId,
        'space.members.manage',
        async (orgId) => {
          if (!(await this.directory.lockActiveMember(orgId, input.userId))) {
            throw new NotFoundError(
              'member-not-found',
              'The member was not found.',
            );
          }
        },
      );
      const orgId = space.organizationId;
      if (await this.roles.roleOf(orgId, space.id, input.userId)) {
        throw new ConflictError(
          'space-member-exists',
          'The user is already a member of the space.',
        );
      }
      const versions = await this.keys.versions(orgId, space.id);
      KeyRotationRules.assertGrantsCoverVersions(
        input.grants.map((g) => g.version),
        versions.map((v) => v.version),
      );
      const byVersion = new Map(versions.map((v) => [v.version, v.id]));
      for (const grant of input.grants) {
        await this.grants.upsert(
          orgId,
          byVersion.get(grant.version)!,
          input.userId,
          grant.wrappedKey,
        );
      }
      await this.roles.assign(
        orgId,
        space.id,
        input.userId,
        roleKey,
        actor.userId,
      );
      // Pendência de trancar aberta por convite (se houver) foi resolvida.
      await this.pending.markGranted(orgId, space.id, input.userId);
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'space.member_added',
        metadata: { spaceId: space.id, targetUserId: input.userId, roleKey },
      });
      return { userId: input.userId, roleKey };
    });
  }
}
