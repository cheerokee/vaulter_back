import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { OrphanRules } from '../domain/orphan.js';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { SpaceAccess } from './space-access.js';

export type RecoveryCopy = {
  version: number;
  recoveryWrappedKey: string;
  recoveryKeyFingerprint: string;
};

export type RecoveryCopiesView = {
  currentVersion: number;
  copies: RecoveryCopy[];
};

// Primeiro passo da reabertura pelo kit (decisão 10): o app do admin precisa das cópias do kit de cada versão
// para abri-las com a parte secreta e trancar para si (`POST /spaces/:id/recover`). Mesma ordem da reabertura:
// 1. espaço resolvido pela organização com org.members.manage (404 / 403), sem gastar o Argon2;
// 2. pré-checagem do órfão (sem lock), também antes da reautenticação;
// 3. reautenticação FORA da transação e ANTES de qualquer leitura de cópia;
// 4. na transação: espaço travado, permissão de novo, órfão de novo (a que vale), leitura das versões e
//    auditoria `space.recovery_copies_read` (só a contagem; nunca as cópias nem a prova).
// Só lê: a cópia do kit é inútil sem a parte secreta do kit, que o backend nunca vê.
@Injectable()
export class GetRecoveryCopiesUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly verifier: CurrentAuthProofVerifier,
    private readonly keys: SpaceKeyRepository,
    private readonly roles: SpaceRoleRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    spaceId: string,
    input: { currentAuthProof: string },
  ): Promise<RecoveryCopiesView> {
    const pre = await this.access.requireOrgPermissionForSpace(
      spaceId,
      actor.userId,
      'org.members.manage',
    );
    OrphanRules.assertOrphan(
      (await this.roles.activeMemberIds(pre.organizationId, pre.id)).length,
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
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'space.recovery_copies_read',
        metadata: { spaceId: space.id, versions: versions.length },
      });
      return {
        currentVersion: space.currentKeyVersion,
        copies: versions.map((v) => ({
          version: v.version,
          recoveryWrappedKey: v.recoveryWrappedKey,
          recoveryKeyFingerprint: v.recoveryKeyFingerprint,
        })),
      };
    });
  }
}
