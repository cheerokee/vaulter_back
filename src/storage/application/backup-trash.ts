import { Injectable, Logger } from '@nestjs/common';
import { objectKey } from '../domain/backup-keys.js';
import type { PurgedVersion } from '../domain/backup-object-version.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { TrashRules } from '../domain/trash-rules.js';
import { ObjectStore } from './ports/object-store.js';

// Apagar de vez versões da lixeira (spec storage-backup §4.8, "Controle da lixeira"), em duas fases:
// 1. no unit of work, com o objeto travado: a linha vira `purged` (relógio do banco) e ganha a marca do diário
//    (`s3_write_started_at`); sai do uso, das listagens e dos downloads (404) no COMMIT;
// 2. DEPOIS do COMMIT (`removeFromBucket`): `deleteVersion` de cada versão no S3, fora da trava. Uma queda entre as
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

  /** After the COMMIT of the purge. Never throws: a failure is logged and the journal mark leaves it to the sweep. */
  async removeFromBucket(
    orgId: string,
    spaceId: string,
    purged: readonly PurgedVersion[],
  ): Promise<void> {
    for (const v of purged) {
      try {
        await this.store.deleteVersion(
          objectKey(orgId, spaceId, v.objectId),
          v.s3VersionId,
        );
      } catch (error) {
        this.logger.warn(
          { err: error, organizationId: orgId, objectId: v.objectId },
          'could not delete a purged backup version from the bucket; the reconcile sweep removes it',
        );
      }
    }
  }
}
