import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { assertOrganizationStorageFits } from '../../organizations/application/organization-storage.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { assertRecoveryPublicKey } from '../domain/recovery-public-key.js';
import { SpaceGrantRepository } from '../domain/space-grant.repository.js';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { Space } from '../domain/space.js';
import { SpaceRepository } from '../domain/space.repository.js';
import { assertWrappedKeys } from './dto/key-inputs.js';
import { toSpaceView, type SpaceView } from './dto/space-view.js';
import { RecoveryKit } from './recovery-kit.js';

export type CreateSpaceInput = {
  name: string;
  /** The space key (version 1) wrapped for the creator. */
  wrappedKey: string;
  /** Public key of the kit the app wrapped for; must be the organization's current kit. */
  recoveryPublicKey: string;
  recoveryWrappedKey: string;
  /** Reserved size; defaults to 10 GiB. Must fit in the organization quota. */
  storageQuotaBytes?: number;
};

// Cria o espaço (org.spaces.create). Formato antes (422 sem tocar no banco); na transação: permissão, kit atual
// (sem kit 422, kit diferente 409), espaço + versão 1 com a impressão do kit DA ORGANIZAÇÃO, a cópia de quem
// criou, quem criou como Gestor, auditoria (sem chave nenhuma). O tamanho reservado cabe na franquia da organização,
// conferido com a linha da organização travada (FOR NO KEY UPDATE) antes do insert: criações e aumentos concorrentes
// se serializam nela.
@Injectable()
export class CreateSpaceUseCase {
  constructor(
    private readonly orgAccess: OrganizationAccess,
    private readonly kit: RecoveryKit,
    private readonly directory: OrganizationDirectory,
    private readonly spaces: SpaceRepository,
    private readonly keys: SpaceKeyRepository,
    private readonly grants: SpaceGrantRepository,
    private readonly roles: SpaceRoleRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    orgId: string,
    input: CreateSpaceInput,
  ): Promise<SpaceView> {
    assertWrappedKeys([input.wrappedKey, input.recoveryWrappedKey]);
    assertRecoveryPublicKey(input.recoveryPublicKey);
    const space = Space.create({
      organizationId: orgId,
      name: input.name,
      now: new Date(),
      ...(input.storageQuotaBytes !== undefined
        ? { storageQuotaBytes: input.storageQuotaBytes }
        : {}),
    });
    return this.uow.run(async () => {
      await this.orgAccess.requirePermission(
        orgId,
        actor.userId,
        'org.spaces.create',
      );
      // Travada antes do kit: a impressão lida em seguida é a do kit atual (uma troca concorrente do kit espera).
      const quota = await this.directory.lockStorageQuota(orgId);
      if (!quota) {
        throw new NotFoundError(
          'organization-not-found',
          'The organization was not found.',
        );
      }
      assertOrganizationStorageFits(quota, space.storageQuotaBytes);
      const fingerprint = await this.kit.assertCurrent(
        orgId,
        input.recoveryPublicKey,
      );
      await this.spaces.create(space);
      const key = await this.keys.addVersion(
        orgId,
        space.id,
        1,
        input.recoveryWrappedKey,
        fingerprint,
      );
      await this.grants.upsert(orgId, key.id, actor.userId, input.wrappedKey);
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
        action: 'space.created',
        metadata: { spaceId: space.id },
      });
      return toSpaceView(space, 'space_manager', false, 0);
    });
  }
}
