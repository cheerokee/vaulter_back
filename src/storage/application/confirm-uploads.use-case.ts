import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { objectKey, uploadKey } from '../domain/backup-keys.js';
import type { BackupObject } from '../domain/backup-object.js';
import { BackupObjectRepository } from '../domain/backup-object.repository.js';
import type { BackupObjectVersion } from '../domain/backup-object-version.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { BackupRules } from '../domain/backup-rules.js';
import { withCompensation } from './compensation.js';
import {
  committedVersionView,
  type CommittedVersionView,
} from './dto/backup-views.js';
import { ObjectStore } from './ports/object-store.js';
import { objectVersionConflict, uploadNotFound } from './storage-errors.js';
import { StorageAccess, type StorageActor } from './storage-access.js';

// Confirmação do envio (spec storage-backup §4.2, passo 3), tudo ou nada por pedido, idempotente.
// No unit of work, com o espaço travado (`StorageAccess.lock`, `memory.write`, FOR UPDATE: serializa com o
// redimensionar — a reserva da intenção já estava no uso, então um encolhimento nunca passa por baixo de um envio em
// andamento —, com a troca de chave e com as outras confirmações e apagamentos do espaço):
// 1. cada `uploadId` precisa ser uma intenção deste espaço (senão 404 `upload-not-found`, também fora da janela de
//    1 dia); uma já confirmada só devolve a versão (repetição depois de um timeout: nada é copiado de novo);
// 2. troca de chave pendente / versão da chave (409), reconferidos AQUI porque podem ter mudado depois da intenção;
// 3. trava os objetos em ordem de id e, na ordem do pedido, confere `replacesVersionId` contra a versão viva
//    (409 `object-version-conflict`: outro Hub gravou antes) e o `HEAD` do provisório (tamanho e sha256 iguais aos
//    declarados, senão 422 `upload-mismatch`: nada entra no índice);
// 4. só então copia cada provisório para `objects/<objectId>` dentro do S3 (os bytes não passam pelo backend) e grava
//    a versão (`committed`, `s3VersionId`), a anterior vira lixeira (`superseded_at`) e o objeto aponta para a nova.
// As cópias acontecem sob o lock do objeto, então a ordem das versões no S3 é a do índice. Se algo falhar depois de
// uma cópia (inclusive o COMMIT), as cópias são removidas (`withCompensation`): a versão atual do S3 volta a ser a
// do índice.
@Injectable()
export class ConfirmUploadsUseCase {
  constructor(
    private readonly access: StorageAccess,
    private readonly objects: BackupObjectRepository,
    private readonly versions: BackupObjectVersionRepository,
    private readonly store: ObjectStore,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: StorageActor,
    spaceId: string,
    uploadIds: readonly string[],
    now: Date = new Date(),
  ): Promise<CommittedVersionView[]> {
    return withCompensation(this.store, (written) =>
      this.uow.run(async () => {
        const space = await this.access.lock(spaceId, actor, 'memory.write');
        const orgId = space.organizationId;
        const found = new Map(
          (await this.versions.findByIds(orgId, space.spaceId, uploadIds)).map(
            (v) => [v.id, v],
          ),
        );
        const toCommit: BackupObjectVersion[] = [];
        for (const id of uploadIds) {
          const version = found.get(id);
          if (!version) throw uploadNotFound(id);
          if (version.status === 'committed') continue;
          if (!version.isConfirmable(now)) throw uploadNotFound(id);
          BackupRules.assertWritable(space, version.keyVersion);
          toCommit.push(version);
        }

        const objectIds = [...new Set(toCommit.map((v) => v.objectId))].sort();
        const locked = new Map<string, BackupObject>();
        for (const objectId of objectIds) {
          const object = await this.objects.lockForUpdate(
            orgId,
            space.spaceId,
            objectId,
          );
          // The intent created the row; it never disappears (the runtime has no DELETE).
          if (!object) throw objectVersionConflict(objectId, null);
          locked.set(objectId, object);
        }

        const superseded: string[] = [];
        for (const version of toCommit) {
          const object = locked.get(version.objectId)!;
          object.assertReplaces(version.replacesVersionId);
          version.assertUploaded(
            await this.store.head(uploadKey(orgId, space.spaceId, version.id)),
          );
          const { supersededVersionId } = object.commit(version.id);
          if (supersededVersionId) superseded.push(supersededVersionId);
        }

        for (const version of toCommit) {
          const key = objectKey(orgId, space.spaceId, version.objectId);
          const { versionId } = await this.store.copy(
            uploadKey(orgId, space.spaceId, version.id),
            key,
          );
          written.push({ key, versionId });
          version.commit(versionId, now);
        }
        for (const version of toCommit) await this.versions.save(version);
        // A version committed and replaced in the same request goes to the trash too.
        if (superseded.length > 0) {
          await this.versions.markSuperseded(orgId, superseded, now);
        }
        for (const objectId of objectIds) {
          await this.objects.save(locked.get(objectId)!);
        }
        return uploadIds.map((id) => committedVersionView(found.get(id)!));
      }),
    );
  }
}
