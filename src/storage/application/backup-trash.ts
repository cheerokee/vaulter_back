import { Injectable, Logger } from '@nestjs/common';
import { objectKey } from '../domain/backup-keys.js';
import type { PurgedVersion } from '../domain/backup-object-version.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { TrashRules } from '../domain/trash-rules.js';
import { ObjectStore } from './ports/object-store.js';

// Apagar de vez versões da lixeira (spec storage-backup §4.8, "Controle da lixeira"), em duas fases:
// 1. no unit of work, com o objeto travado: a linha vira `purged` (relógio do banco) e ganha a marca do diário
//    (`s3_write_started_at`); sai do uso, das listagens e dos downloads (404) no COMMIT;
// 2. DEPOIS do COMMIT (`removeFromBucket`): `DeleteObjects` em lote no S3 (até 1000 versões por chamada), fora da trava. Uma queda entre as
//    duas fases deixa no bucket uma versão que o índice não referencia, nunca o contrário (o índice apontando para uma
//    versão apagada como baixável): a varredura (`storage:reconcile`, pela marca) ou o próximo toque do objeto a tiram
//    com o `BackupObjectHealer` (só referencia `committed`), e o ciclo de vida de 30 dias a apagaria de qualquer jeito.
// Fora da trava é seguro: a versão apagada nunca é a atual do S3 (a atual é a viva do índice, ou o delete marker de
// um objeto apagado), e apagar uma versão que o reparo já tirou não faz nada.
@Injectable()
export class BackupTrash {
  private readonly logger = new Logger(BackupTrash.name);

  constructor(
    private readonly versions: BackupObjectVersionRepository,
    private readonly store: ObjectStore,
  ) {}

  /**
   * MUST run inside `UnitOfWork.run` with the object row locked `FOR UPDATE`, after the new version superseded the
   * previous one: purges the superseded versions beyond the per-object cap (the 10 most recent stay).
   */
  async capObject(
    orgId: string,
    spaceId: string,
    objectId: string,
  ): Promise<PurgedVersion[]> {
    const ids = TrashRules.beyondCap(
      await this.versions.supersededInTrash(orgId, objectId),
    );
    return ids.length > 0 ? this.versions.markPurged(orgId, spaceId, ids) : [];
  }

  /**
   * After the COMMIT of the purge: one batched S3 call per 1000 versions (`deleteVersions`), so a full batch of the
   * "empty the trash" never turns into 1000 sequential requests. Never throws: what was not deleted (per-key errors, a
   * failed call) is logged and keeps its journal mark, so the reconcile sweep removes it.
   */
  async removeFromBucket(
    orgId: string,
    spaceId: string,
    purged: readonly PurgedVersion[],
  ): Promise<void> {
    if (purged.length === 0) return;
    try {
      const { failed } = await this.store.deleteVersions(
        purged.map((v) => ({
          key: objectKey(orgId, spaceId, v.objectId),
          versionId: v.s3VersionId,
        })),
      );
      if (failed.length > 0) {
        this.logger.warn(
          { organizationId: orgId, spaceId, failed: failed.length },
          'could not delete purged backup versions from the bucket; the reconcile sweep removes them',
        );
      }
    } catch (error) {
      this.logger.warn(
        { err: error, organizationId: orgId, spaceId, versions: purged.length },
        'could not delete purged backup versions from the bucket; the reconcile sweep removes them',
      );
    }
  }
}
