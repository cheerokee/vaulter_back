import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { assertOrganizationStorageFits } from '../../organizations/application/organization-storage.js';
import { SpaceQuotaHooks } from '../../shared/application/space-quota-hooks.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import { SpaceRepository } from '../domain/space.repository.js';
import type { SpaceView } from './dto/space-view.js';
import { toSpaceView } from './dto/space-view.js';
import { RecoveryKit } from './recovery-kit.js';
import { SpaceAccess } from './space-access.js';
import { SpaceStorageUsage } from './space-storage-usage.js';

// Muda o tamanho reservado do espaço (`PUT /spaces/:id/storage-quota`, Gestor: `space.members.manage`; spec
// storage-backup §4.4). Diminuir: nunca abaixo do uso (lixeira inclusa), 422 `space-storage-quota-below-usage`.
// Aumentar: cabe na franquia da organização (422 `organization-storage-quota-exceeded`) e na capacidade de cada Hub
// onde o espaço está instalado (os ganchos `SpaceQuotaHooks`: 422 `hub-storage-full` com `hubId`; `missingBytes` só para o dono do Hub).
// Locks, nesta ordem: os Hubs do espaço (gancho `lock`, antes do espaço: ordem Hub -> vínculo -> hub_space -> espaço)
// -> o espaço (FOR UPDATE, `lockAsMember`) -> a linha da organização (FOR NO KEY UPDATE, folha; só no aumento).
@Injectable()
export class ResizeSpaceStorageUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly kit: RecoveryKit,
    private readonly spaces: SpaceRepository,
    private readonly keys: SpaceKeyRepository,
    private readonly directory: OrganizationDirectory,
    private readonly usage: SpaceStorageUsage,
    private readonly hooks: SpaceQuotaHooks,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    spaceId: string,
    input: { storageQuotaBytes: number },
  ): Promise<SpaceView> {
    return this.uow.run(async () => {
      const { space, roleKey } = await this.access.lockAsMember(
        spaceId,
        actor.userId,
        'space.members.manage',
        (organizationId) => this.hooks.lock({ organizationId, spaceId }),
      );
      const organizationId = space.organizationId;
      const usedBytes = await this.usage.usedBytes(organizationId, space.id);
      const { fromBytes, toBytes } = space.resizeStorage(
        input.storageQuotaBytes,
        usedBytes,
      );
      if (toBytes > fromBytes) {
        const quota = await this.directory.lockStorageQuota(organizationId);
        if (!quota) {
          throw new NotFoundError(
            'space-not-found',
            'The space was not found.',
          );
        }
        // O reservado já conta o tamanho atual deste espaço: só a diferença precisa caber.
        assertOrganizationStorageFits(quota, toBytes - fromBytes);
        await this.hooks.assertIncrease({
          organizationId,
          spaceId: space.id,
          actorUserId: actor.userId,
          fromBytes,
          toBytes,
        });
      }
      if (toBytes !== fromBytes) {
        await this.spaces.save(space);
        await this.audit.record({
          organizationId,
          userId: actor.userId,
          action: 'space.storage_quota_changed',
          metadata: { spaceId: space.id, fromBytes, toBytes },
        });
      }
      // Relida depois do save (ainda sob o lock), como no renomear: o updated_at é o que o banco gravou.
      const saved =
        (await this.spaces.findById(organizationId, space.id)) ?? space;
      const versions = await this.keys.versions(organizationId, space.id);
      return toSpaceView(
        saved,
        roleKey,
        await this.kit.isRewrapRequired(organizationId, versions),
        usedBytes,
      );
    });
  }
}
