import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { KeyRotationRules } from '../domain/key-rotation.js';
import { OrphanRules } from '../domain/orphan.js';
import { SpaceGrantRepository } from '../domain/space-grant.repository.js';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import type { SpaceRoleKey } from '../domain/space-membership.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { assertWrappedKeys, type VersionGrantInput } from './dto/key-inputs.js';
import { SpaceAccess } from './space-access.js';

export type RecoverOrphanSpaceInput = {
  /** Every version, wrapped for the admin (the app opened the kit copies with the kit secret). */
  grants: VersionGrantInput[];
  currentAuthProof: string;
};

// Reabertura de um espaço órfão pelo kit (decisão 10): a ÚNICA forma de um admin se pôr num espaço. Ordem:
// 1. formato das cópias (422, sem gastar o Argon2);
// 2. espaço resolvido pela organização com org.members.manage (não admin 404; membro do espaço sem a permissão
//    403), também sem gastar o Argon2;
// 3. reautenticação FORA da transação;
// 4. na transação: espaço travado, permissão de novo, nenhum membro ativo (`space-not-orphan`), cópias de todas
//    as versões, o admin entra como Gestor, auditoria `space.recovered_with_kit` (sem cópia nem prova).
@Injectable()
export class RecoverOrphanSpaceUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly verifier: CurrentAuthProofVerifier,
    private readonly keys: SpaceKeyRepository,
    private readonly grants: SpaceGrantRepository,
    private readonly roles: SpaceRoleRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    spaceId: string,
    input: RecoverOrphanSpaceInput,
  ): Promise<{ roleKey: SpaceRoleKey }> {
    assertWrappedKeys(input.grants.map((g) => g.wrappedKey));
    await this.access.requireOrgPermissionForSpace(
      spaceId,
      actor.userId,
      'org.members.manage',
    );
    await this.verifier.verify(actor.userId, input.currentAuthProof);
    return this.uow.run(async () => {
      const space = await this.access.lockWithOrgPermission(
        spaceId,
        actor.userId,
        'org.members.manage',
      );
      const orgId = space.organizationId;
      OrphanRules.assertOrphan(
        (await this.roles.activeMemberIds(orgId, space.id)).length,
      );
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
          actor.userId,
          grant.wrappedKey,
        );
      }
      await this.roles.assign(
        orgId,
        space.id,
        actor.userId,
        'space_manager',
        actor.userId,
      );
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'space.recovered_with_kit',
        metadata: { spaceId: space.id, versions: versions.length },
      });
      return { roleKey: 'space_manager' };
    });
  }
}
