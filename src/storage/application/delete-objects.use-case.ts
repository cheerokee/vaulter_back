import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { objectKey } from '../domain/backup-keys.js';
import { INDEX_TAIL_TIMEOUT_MS } from '../domain/backup-limits.js';
import type { BackupObject } from '../domain/backup-object.js';
import { BackupObjectRepository } from '../domain/backup-object.repository.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { BackupRules } from '../domain/backup-rules.js';
import { BackupObjectHealer, type ObjectRef } from './backup-object-healer.js';
import type { DeleteObjectInput } from './dto/backup-views.js';
import { ObjectStore } from './ports/object-store.js';
import { assertStillMarked } from './journal.js';
import { objectVersionConflict } from './storage-errors.js';
import { StorageAccess, type StorageActor } from './storage-access.js';

// Apagar objetos (spec storage-backup §4.2, "Apagar"), tudo ou nada por pedido, idempotente. Exige `memory.delete`:
// na prática só uma pessoa Gestora do espaço (Sala nenhuma tem a permissão: o Hub com o próprio token recebe 404).
// O diário (marca, relógio do banco, na versão viva que cada item diz apagar) é gravado ANTES, numa transação curta
// própria, depois da checagem de `memory.delete`. Depois, com o espaço travado FOR SHARE (apagar não aumenta o uso),
// trava os objetos em ordem de id (reparando antes o que tiver marca mais antiga que a deste pedido) e confere
// `replacesVersionId` contra a versão viva (409 `object-version-conflict`; apagar de novo com a mesma versão não faz
// nada). Reconfere a marca (409 `storage-busy` se sumiu), então: delete marker no S3 (a versão fica na lixeira 30
// dias), lápide no objeto e `superseded_at` na versão. As marcas nunca são limpas aqui (só pela varredura). Uma troca
// de chave pendente não impede apagar. Se o unit of work rejeitar depois do S3, os objetos são reparados (`repair`):
// com a lápide confirmada os markers ficam; sem ela, saem.
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
    // Diário ANTES do unit of work (transação curta própria, relógio do banco; veja ConfirmUploadsUseCase), depois da
    // checagem de `memory.delete`: marca a versão que cada item diz apagar, se for a viva.
    const marks = await this.uow.run(async () => {
      const space = await this.access.lock(
        spaceId,
        actor,
        'memory.delete',
        'share',
      );
      return this.versions.markLiveWrites(
        space.organizationId,
        space.spaceId,
        items.map((i) => ({
          objectId: i.objectId,
          versionId: i.replacesVersionId,
        })),
      );
    });
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
          const mine = marks.get(i.replacesVersionId);
          if (
            mine &&
            (await this.versions.hasWriteMarksBefore(orgId, object.id, mine))
          ) {
            await this.healer.heal(object);
          }
          const result = object.delete(i.replacesVersionId, now);
          if (result.outcome === 'deleted') {
            deleted.push(object);
            superseded.push(result.supersededVersionId);
          }
        }
        if (deleted.length === 0) return;
        // Nenhum delete marker sem a marca desta tentativa (reconferida sob a trava; senão 409 `storage-busy`).
        assertStillMarked(
          marks,
          await this.versions.writeMarks(orgId, superseded),
          superseded,
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
        // Daqui ao COMMIT só gravações curtas no índice: o carimbo de `updated_at` (relógio do banco, abaixo) fica no
        // máximo INDEX_TAIL_TIMEOUT_MS antes do COMMIT, ou a transação morre (garantia da folga do `since`).
        await this.uow.limitRemainingTime(INDEX_TAIL_TIMEOUT_MS);
        await this.versions.markSuperseded(orgId, superseded);
        // As marcas ficam: só a varredura por idade as limpa.
        for (const object of deleted) await this.objects.save(object);
      });
    } catch (error) {
      if (writing.length > 0) await this.healer.repair(writing);
      throw error;
    }
  }
}
