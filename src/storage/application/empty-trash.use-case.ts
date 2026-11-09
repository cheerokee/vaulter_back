import { Injectable } from '@nestjs/common';
import { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { BackupObject } from '../domain/backup-object.js';
import { BackupObjectRepository } from '../domain/backup-object.repository.js';
import type { PurgedVersion } from '../domain/backup-object-version.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { MAX_PURGE_BATCH_VERSIONS } from '../domain/backup-limits.js';
import { TrashRules } from '../domain/trash-rules.js';
import { BackupTrash } from './backup-trash.js';
import { lockTimeoutAsBusy } from './storage-errors.js';
import { StorageAccess } from './storage-access.js';

export type EmptyTrashResult = {
  purgedVersions: number;
  purgedBytes: number;
  /** Trash versions still there: the app repeats the request while this is above 0. */
  remainingVersions: number;
};

// Esvaziar a lixeira do espaço (spec storage-backup §4.8, "Controle da lixeira", decisão do Jonas de 2026-11-09):
// só o Gestor (`space.members.manage`), com reautenticação. Ordem:
// 1. permissão sem trava (404 não membro, 403 sem a permissão), sem gastar o Argon2;
// 2. reautenticação (`CurrentAuthProofVerifier`, 422 `current-auth-proof-invalid`), ANTES de qualquer gravação;
// 3. no unit of work: espaço FOR SHARE (`StorageAccess.lock`, com o `lock_timeout` do storage: 409 `storage-busy`),
//    até 1000 versões da lixeira (`MAX_PURGE_BATCH_VERSIONS`), objetos FOR UPDATE em ordem de id (a ordem da
//    confirmação e do apagar), `purged` no índice (nunca a versão viva de um objeto vivo; `TrashRules.purgeable` é a
//    segunda trava sobre o SQL), auditoria `space.backup.trash_emptied`;
// 4. depois do COMMIT, `DeleteObjects` em lote no S3 (`BackupTrash.removeFromBucket`; veja lá a regra de queda).
// Um pedido que não apaga nada responde `remainingVersions: 0` (o laço do app nunca gira sem progresso).
// Os delete markers dos objetos apagados ficam (o ciclo de vida os remove). O app repete enquanto
// `remainingVersions > 0` (cada repetição gasta o orçamento de reautenticação).
@Injectable()
export class EmptyTrashUseCase {
  constructor(
    private readonly access: StorageAccess,
    private readonly verifier: CurrentAuthProofVerifier,
    private readonly objects: BackupObjectRepository,
    private readonly versions: BackupObjectVersionRepository,
    private readonly trash: BackupTrash,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: { userId: string },
    spaceId: string,
    currentAuthProof: string,
  ): Promise<EmptyTrashResult> {
    await this.access.require(spaceId, actor, 'space.members.manage');
    await this.verifier.verify(actor.userId, currentAuthProof);
    let committed: {
      orgId: string;
      spaceId: string;
      purged: PurgedVersion[];
      remainingVersions: number;
    };
    try {
      committed = await this.uow.run(async () => {
        const space = await this.access.lock(
          spaceId,
          actor,
          'space.members.manage',
          'share',
        );
        const orgId = space.organizationId;
        const candidates = await this.versions.trashCandidates(
          orgId,
          space.spaceId,
          MAX_PURGE_BATCH_VERSIONS,
        );
        if (candidates.length === 0) {
          return {
            orgId,
            spaceId: space.spaceId,
            purged: [],
            remainingVersions: 0,
          };
        }
        const locked: BackupObject[] = [];
        for (const objectId of [
          ...new Set(candidates.map((c) => c.objectId)),
        ].sort()) {
          const object = await this.objects.lockForUpdate(
            orgId,
            space.spaceId,
            objectId,
          );
          if (object) locked.push(object);
        }
        const lockedIds = new Set(locked.map((o) => o.id));
        const ids = TrashRules.purgeable(
          candidates.filter((c) => lockedIds.has(c.objectId)).map((c) => c.id),
          locked,
        );
        const purged =
          ids.length > 0
            ? await this.versions.markPurged(orgId, space.spaceId, ids)
            : [];
        const { versions: remainingVersions } = await this.versions.trashUsage(
          orgId,
          space.spaceId,
        );
        if (purged.length > 0) {
          await this.audit.record({
            organizationId: orgId,
            userId: actor.userId,
            action: 'space.backup.trash_emptied',
            metadata: {
              spaceId: space.spaceId,
              purgedVersions: purged.length,
              purgedBytes: bytesOf(purged),
            },
          });
        }
        // Garantia de progresso: um pedido que não apagou nada responde 0, e o laço do app (repete enquanto
        // `remainingVersions > 0`, cada volta gastando o orçamento de reautenticação) sempre para.
        return {
          orgId,
          spaceId: space.spaceId,
          purged,
          remainingVersions: purged.length > 0 ? remainingVersions : 0,
        };
      });
    } catch (error) {
      throw lockTimeoutAsBusy(error);
    }
    await this.trash.removeFromBucket(
      committed.orgId,
      committed.spaceId,
      committed.purged,
    );
    return {
      purgedVersions: committed.purged.length,
      purgedBytes: bytesOf(committed.purged),
      remainingVersions: committed.remainingVersions,
    };
  }
}

function bytesOf(purged: readonly PurgedVersion[]): number {
  return purged.reduce((sum, v) => sum + v.sizeBytes, 0);
}
