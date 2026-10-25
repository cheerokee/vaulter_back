import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { KeyRotationRules } from '../domain/key-rotation.js';
import { assertRecoveryPublicKey } from '../domain/recovery-public-key.js';
import { SpaceGrantRepository } from '../domain/space-grant.repository.js';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { SpaceRepository } from '../domain/space.repository.js';
import { assertWrappedKeys } from './dto/key-inputs.js';
import { RecoveryKit } from './recovery-kit.js';
import { SpaceAccess } from './space-access.js';

export type RotateSpaceKeyInput = {
  /** Must be current_key_version + 1. */
  version: number;
  recoveryPublicKey: string;
  recoveryWrappedKey: string;
  /** Exactly one copy per ACTIVE member of the space. */
  grants: { userId: string; wrappedKey: string }[];
};

// Nova versão da chave (decisão 6). Qualquer membro ativo (não precisa ser Gestor). Com o espaço travado:
// versão = atual + 1 e o conjunto de destinatários = exatamente os membros ativos lidos sob o lock (quem saiu
// não recebe a versão nova; quem entrou no meio não fica de fora). Divergência: 409 `key-rotation-mismatch`,
// para o app recarregar. A auditoria leva só a versão.
@Injectable()
export class RotateSpaceKeyUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly kit: RecoveryKit,
    private readonly spaces: SpaceRepository,
    private readonly keys: SpaceKeyRepository,
    private readonly grants: SpaceGrantRepository,
    private readonly roles: SpaceRoleRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    spaceId: string,
    input: RotateSpaceKeyInput,
  ): Promise<{ currentVersion: number }> {
    assertRecoveryPublicKey(input.recoveryPublicKey);
    assertWrappedKeys([
      input.recoveryWrappedKey,
      ...input.grants.map((g) => g.wrappedKey),
    ]);
    return this.uow.run(async () => {
      const { space } = await this.access.lockAsMember(spaceId, actor.userId);
      const orgId = space.organizationId;
      const fingerprint = await this.kit.assertCurrent(
        orgId,
        input.recoveryPublicKey,
      );
      // Só em memória até aqui: lança `key-rotation-mismatch` se a versão não for a seguinte.
      space.completeRotation(input.version);
      KeyRotationRules.assertGrantsMatchMembers(
        input.grants.map((g) => g.userId),
        await this.roles.activeMemberIds(orgId, space.id),
      );
      const key = await this.keys.addVersion(
        orgId,
        space.id,
        input.version,
        input.recoveryWrappedKey,
        fingerprint,
      );
      for (const grant of input.grants) {
        await this.grants.upsert(orgId, key.id, grant.userId, grant.wrappedKey);
      }
      await this.spaces.save(space);
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'space.key_rotated',
        metadata: { spaceId: space.id, version: input.version },
      });
      return { currentVersion: space.currentKeyVersion };
    });
  }
}
