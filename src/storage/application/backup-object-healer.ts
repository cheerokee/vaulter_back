import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { objectKey } from '../domain/backup-keys.js';
import type { BackupObject } from '../domain/backup-object.js';
import { BackupObjectRepository } from '../domain/backup-object.repository.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { ObjectStore } from './ports/object-store.js';

export type ObjectRef = {
  organizationId: string;
  spaceId: string;
  objectId: string;
};

// Reparo do bucket contra o índice (o índice é a verdade). Uma cópia ou um delete marker gravado no S3 sem o COMMIT
// do índice (queda entre o S3 e o banco, COMMIT perdido) deixaria a versão atual do S3 diferente da do índice: a do
// índice viraria "não atual" e o ciclo de vida a apagaria em 30 dias. Regra, com a linha do objeto TRAVADA (toda
// gravação no S3 de um objeto acontece sob essa trava, então nenhuma está em andamento — inclusive um COMMIT de
// resultado incerto já se resolveu quando a trava é obtida):
// - NUNCA apaga uma versão referenciada por uma versão `committed` do índice (lixeira inclusa);
// - objeto vivo (ou sem versão confirmada): apaga toda outra versão e todo delete marker — a atual volta a ser a do
//   índice (markers antigos de antes de um "voltar" não carregam dado);
// - objeto apagado (lápide): apaga só as versões com dado não referenciadas; os delete markers ficam (o atual é um).
// Toda leitura/download usa o `s3VersionId` do índice, nunca a versão "atual" do S3 (regra do módulo, CLAUDE.md).
@Injectable()
export class BackupObjectHealer {
  private readonly logger = new Logger(BackupObjectHealer.name);

  constructor(
    private readonly objects: BackupObjectRepository,
    private readonly versions: BackupObjectVersionRepository,
    private readonly store: ObjectStore,
    private readonly uow: UnitOfWork,
  ) {}

  /**
   * MUST run inside `UnitOfWork.run` with the object row locked `FOR UPDATE`. Returns how many S3 versions were
   * removed. `clearMarksBefore`: only the age-gated sweep clears marks (those older than it): right after a failure an
   * aborted S3 request may still land server-side, so the mark must stay until the sweep looks again.
   */
  async heal(
    object: BackupObject,
    options: { clearMarksBefore?: Date } = {},
  ): Promise<number> {
    const orgId = object.organizationId;
    const referenced = new Set(
      await this.versions.committedS3VersionIds(orgId, object.id),
    );
    const key = objectKey(orgId, object.spaceId, object.id);
    const deleted = object.deletedAt !== null;
    let removed = 0;
    for (const v of await this.store.listVersions(key)) {
      if (referenced.has(v.versionId)) continue;
      if (v.isDeleteMarker && deleted) continue;
      await this.store.deleteVersion(key, v.versionId);
      removed++;
    }
    if (options.clearMarksBefore) {
      await this.versions.clearWriteMarks(
        orgId,
        object.id,
        options.clearMarksBefore,
      );
    }
    if (removed > 0) {
      this.logger.warn(
        { organizationId: orgId, objectId: object.id, removed },
        'removed S3 versions the backup index does not reference',
      );
    }
    return removed;
  }

  /**
   * Repairs each object in its own unit of work (locks the row, waits for any writer). Marks are cleared only when
   * `clearMarksBefore` is given (the sweep). Never throws: a failure is logged and the marks stay for the next sweep.
   * Returns the removed S3 versions.
   */
  async repair(
    refs: readonly ObjectRef[],
    clearMarksBefore?: Date,
  ): Promise<number> {
    let removed = 0;
    for (const ref of refs) {
      try {
        removed += await this.uow.run(async () => {
          const object = await this.objects.lockForUpdate(
            ref.organizationId,
            ref.spaceId,
            ref.objectId,
          );
          return object ? this.heal(object, { clearMarksBefore }) : 0;
        });
      } catch (error) {
        this.logger.error(
          { err: error, ...ref },
          'could not repair a backup object; its write mark stays for the next sweep',
        );
      }
    }
    return removed;
  }
}
