import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { objectKey } from '../domain/backup-keys.js';
import type { BackupObject } from '../domain/backup-object.js';
import { BackupObjectRepository } from '../domain/backup-object.repository.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { BackupRules } from '../domain/backup-rules.js';
import { withCompensation } from './compensation.js';
import type { DeleteObjectInput } from './dto/backup-views.js';
import { ObjectStore } from './ports/object-store.js';
import { objectVersionConflict } from './storage-errors.js';
import { StorageAccess, type StorageActor } from './storage-access.js';

// Apagar objetos (spec storage-backup §4.2, "Apagar"), tudo ou nada por pedido, idempotente. Exige `memory.delete`:
// na prática só uma pessoa Gestora do espaço (Sala nenhuma tem a permissão: o Hub com o próprio token recebe 404).
// Com o espaço travado (FOR UPDATE), trava os objetos em ordem de id e confere `replacesVersionId` contra a versão
// viva (409 `object-version-conflict`; apagar de novo com a mesma versão não faz nada). Depois: delete marker no S3
// (a versão fica na lixeira 30 dias), lápide no objeto e `superseded_at` na versão. Uma troca de chave pendente não
// impede apagar (nada novo é cifrado). Falhou depois de um marker: ele é removido (`withCompensation`).
@Injectable()
export class DeleteObjectsUseCase {
  constructor(
    private readonly access: StorageAccess,
    private readonly objects: BackupObjectRepository,
    private readonly versions: BackupObjectVersionRepository,
    private readonly store: ObjectStore,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: StorageActor,
    spaceId: string,
    items: readonly DeleteObjectInput[],
    now: Date = new Date(),
  ): Promise<void> {
    BackupRules.assertDistinctObjects(items.map((i) => i.objectId));
    await withCompensation(this.store, (written) =>
      this.uow.run(async () => {
        const space = await this.access.lock(spaceId, actor, 'memory.delete');
        const orgId = space.organizationId;
        const sorted = [...items].sort((a, b) =>
          a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0,
        );
        const deleted: BackupObject[] = [];
        const superseded: string[] = [];
        for (const i of sorted) {
          const object = await this.objects.lockForUpdate(
            orgId,
            space.spaceId,
            i.objectId,
          );
          if (!object) throw objectVersionConflict(i.objectId, null);
          const result = object.delete(i.replacesVersionId, now);
          if (result.outcome === 'deleted') {
            deleted.push(object);
            superseded.push(result.supersededVersionId);
          }
        }
        for (const object of deleted) {
          const key = objectKey(orgId, space.spaceId, object.id);
          const { deleteMarkerVersionId } = await this.store.deleteCurrent(key);
          written.push({ key, versionId: deleteMarkerVersionId });
        }
        if (superseded.length > 0) {
          await this.versions.markSuperseded(orgId, superseded, now);
        }
        for (const object of deleted) await this.objects.save(object);
      }),
    );
  }
}
