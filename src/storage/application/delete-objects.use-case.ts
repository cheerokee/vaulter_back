import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { objectKey } from '../domain/backup-keys.js';
import type { BackupObject } from '../domain/backup-object.js';
import { BackupObjectRepository } from '../domain/backup-object.repository.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { BackupRules } from '../domain/backup-rules.js';
import { BackupObjectHealer, type ObjectRef } from './backup-object-healer.js';
import type { DeleteObjectInput } from './dto/backup-views.js';
import { ObjectStore } from './ports/object-store.js';
import { objectVersionConflict } from './storage-errors.js';
import { StorageAccess, type StorageActor } from './storage-access.js';

// Apagar objetos (spec storage-backup §4.2, "Apagar"), tudo ou nada por pedido, idempotente. Exige `memory.delete`:
// na prática só uma pessoa Gestora do espaço (Sala nenhuma tem a permissão: o Hub com o próprio token recebe 404).
// Com o espaço travado FOR SHARE (apagar não aumenta o uso), trava os objetos em ordem de id (reparando antes o que
// tiver marca de uma gravação no S3 que não confirmou) e confere `replacesVersionId` contra a versão viva (409
// `object-version-conflict`; apagar de novo com a mesma versão não faz nada). Depois: marca o diário (autocommit),
// delete marker no S3 (a versão fica na lixeira 30 dias), lápide no objeto, `superseded_at` na versão e limpa as
// marcas. Uma troca de chave pendente não impede apagar (nada novo é cifrado). Se o unit of work rejeitar depois do
// S3, os objetos são reparados (`repair`): com a lápide confirmada os markers ficam; sem ela, saem.
@Injectable()
export class DeleteObjectsUseCase {
  constructor(
    private readonly access: StorageAccess,
    private readonly objects: BackupObjectRepository,
    private readonly versions: BackupObjectVersionRepository,
    private readonly store: ObjectStore,
    private readonly healer: BackupObjectHealer,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: StorageActor,
    spaceId: string,
    items: readonly DeleteObjectInput[],
    now: Date = new Date(),
  ): Promise<void> {
    BackupRules.assertDistinctObjects(items.map((i) => i.objectId));
    const writing: ObjectRef[] = [];
    try {
      await this.uow.run(async () => {
        const space = await this.access.lock(
          spaceId,
          actor,
          'memory.delete',
          'share',
        );
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
          if (await this.versions.hasWriteMarks(orgId, object.id)) {
            await this.healer.heal(object, { clearMarks: false });
          }
          const result = object.delete(i.replacesVersionId, now);
          if (result.outcome === 'deleted') {
            deleted.push(object);
            superseded.push(result.supersededVersionId);
          }
        }
        if (deleted.length === 0) return;

        await this.uow.detached(() =>
          this.versions.markWriteStarted(orgId, superseded),
        );
        for (const object of deleted) {
          writing.push({
            organizationId: orgId,
            spaceId: space.spaceId,
            objectId: object.id,
          });
        }
        for (const object of deleted) {
          await this.store.deleteCurrent(
            objectKey(orgId, space.spaceId, object.id),
          );
        }
        await this.versions.markSuperseded(orgId, superseded, now);
        for (const object of deleted) {
          await this.objects.save(object);
          await this.versions.clearWriteMarks(orgId, object.id);
        }
      });
    } catch (error) {
      if (writing.length > 0) await this.healer.repair(writing);
      throw error;
    }
  }
}
