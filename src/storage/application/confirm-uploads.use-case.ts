import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { objectKey, uploadKey } from '../domain/backup-keys.js';
import type { BackupObject } from '../domain/backup-object.js';
import { BackupObjectRepository } from '../domain/backup-object.repository.js';
import type { BackupObjectVersion } from '../domain/backup-object-version.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { BackupRules } from '../domain/backup-rules.js';
import { BackupObjectHealer, type ObjectRef } from './backup-object-healer.js';
import {
  committedVersionView,
  type CommittedVersionView,
} from './dto/backup-views.js';
import { ObjectStore } from './ports/object-store.js';
import { assertStillMarked } from './journal.js';
import { objectVersionConflict, uploadNotFound } from './storage-errors.js';
import {
  StorageAccess,
  type StorageActor,
  uploaderOf,
} from './storage-access.js';

function sameUploader(
  version: BackupObjectVersion,
  actor: StorageActor,
): boolean {
  const a = uploaderOf(actor);
  const b = version.uploader;
  return 'hubId' in a
    ? 'hubId' in b && a.hubId === b.hubId
    : 'userId' in b && a.userId === b.userId;
}

// Confirmação do envio (spec storage-backup §4.2, passo 3), tudo ou nada por pedido, idempotente.
// No unit of work, com o espaço travado FOR SHARE (`StorageAccess.lock`, `memory.write`): serializa com o
// redimensionar e a troca de chave (FOR UPDATE) — a reserva da intenção já está no uso, então um encolhimento nunca
// passa por baixo de um envio em andamento —, mas não com outras confirmações (a ordem entre elas é a trava dos objetos):
// 1. cada `uploadId` precisa ser uma intenção deste espaço feita por QUEM confirma (o mesmo Hub ou a mesma pessoa),
//    senão 404 `upload-not-found` (também fora da janela de 1 dia); uma já confirmada só devolve a versão (repetição
//    depois de um timeout: nada é copiado de novo);
// 2. troca de chave pendente / versão da chave (409), reconferidos AQUI porque podem ter mudado depois da intenção;
// 3. trava os objetos em ordem de id; objeto com marca mais antiga que as deste pedido (outra tentativa) é reparado
//    antes (`BackupObjectHealer`); na ordem do pedido, confere `replacesVersionId` contra a versão viva (409
//    `object-version-conflict`) e o `HEAD` do provisório (tamanho e sha256 iguais aos declarados, senão 422
//    `upload-mismatch`: nada entra no índice);
// 4. reconfere que cada linha ainda tem a marca desta tentativa (senão 409 `storage-busy`), copia cada provisório para
//    `objects/<objectId>` dentro do S3 (os bytes não passam pelo backend) e grava a versão (`committed`,
//    `s3VersionId`); a anterior vira lixeira (`superseded_at`) e o objeto aponta para a nova.
// O diário (`s3_write_started_at`, relógio do banco) é gravado ANTES, numa transação curta própria (depois da checagem
// de acesso, só nas intenções de quem confirma): sobrevive a qualquer falha do unit of work, nunca exige uma segunda
// conexão enquanto ele segura a dele e nunca é limpo no commit (só pela varredura por idade).
// As cópias acontecem sob a trava do objeto, então a ordem das versões no S3 é a do índice. Se o unit of work
// rejeitar depois de começar a gravar no S3 (inclusive um COMMIT de resultado incerto), os objetos são reparados numa
// transação nova (`repair`): só o que nenhuma versão confirmada referencia sai do bucket. As marcas ficam.
@Injectable()
export class ConfirmUploadsUseCase {
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
    uploadIds: readonly string[],
    now: Date = new Date(),
  ): Promise<CommittedVersionView[]> {
    const writing: ObjectRef[] = [];
    // Diário ANTES do unit of work (transação curta própria, confirmada; relógio do banco): marca só as intenções
    // pendentes de QUEM confirma, depois da checagem de acesso. Nunca é preciso uma segunda conexão do pool enquanto o
    // unit of work segura a dele, e a marca sobrevive a qualquer falha do que vem depois.
    const marks = await this.uow.run(async () => {
      const space = await this.access.lock(
        spaceId,
        actor,
        'memory.write',
        'share',
      );
      return this.versions.markPendingWrites(
        space.organizationId,
        space.spaceId,
        uploadIds,
        uploaderOf(actor),
      );
    });
    try {
      return await this.uow.run(async () => {
        const space = await this.access.lock(
          spaceId,
          actor,
          'memory.write',
          'share',
        );
        const orgId = space.organizationId;
        const found = new Map(
          (await this.versions.findByIds(orgId, space.spaceId, uploadIds)).map(
            (v) => [v.id, v],
          ),
        );
        const toCommit: BackupObjectVersion[] = [];
        for (const id of uploadIds) {
          const version = found.get(id);
          if (!version || !sameUploader(version, actor))
            throw uploadNotFound(id);
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
          // Marca mais antiga que as desta tentativa = outra tentativa que pode ter gravado no S3 sem o índice.
          const mine = toCommit
            .filter((v) => v.objectId === objectId)
            .map((v) => marks.get(v.id))
            .filter((d): d is Date => d !== undefined);
          if (
            mine.length > 0 &&
            (await this.versions.hasWriteMarksBefore(
              orgId,
              objectId,
              new Date(Math.min(...mine.map((d) => d.getTime()))),
            ))
          ) {
            await this.healer.heal(object);
          }
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
        if (toCommit.length === 0) {
          return uploadIds.map((id) => committedVersionView(found.get(id)!));
        }

        // Nenhuma gravação no S3 sem a marca desta tentativa: reconferida sob a trava dos objetos (uma varredura pode
        // tê-la limpado se o pedido ficou parado entre o diário e aqui). Sem ela: 409 `storage-busy`, repetível.
        assertStillMarked(
          marks,
          await this.versions.writeMarks(
            orgId,
            toCommit.map((v) => v.id),
          ),
          toCommit.map((v) => v.id),
        );
        for (const objectId of objectIds) {
          writing.push({
            organizationId: orgId,
            spaceId: space.spaceId,
            objectId,
          });
        }
        for (const version of toCommit) {
          const { versionId } = await this.store.copy(
            uploadKey(orgId, space.spaceId, version.id),
            objectKey(orgId, space.spaceId, version.objectId),
          );
          version.commit(versionId, now);
        }
        for (const version of toCommit) await this.versions.save(version);
        // A version committed and replaced in the same request goes to the trash too.
        if (superseded.length > 0) {
          await this.versions.markSuperseded(orgId, superseded, now);
        }
        // As marcas NÃO são limpas aqui: uma cópia abortada de outra tentativa ainda pode chegar ao S3; só a
        // varredura por idade as limpa, depois de reparar o objeto.
        for (const objectId of objectIds) {
          await this.objects.save(locked.get(objectId)!);
        }
        return uploadIds.map((id) => committedVersionView(found.get(id)!));
      });
    } catch (error) {
      if (writing.length > 0) await this.healer.repair(writing);
      throw error;
    }
  }
}
