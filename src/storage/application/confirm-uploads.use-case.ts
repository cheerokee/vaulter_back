import { Injectable } from '@nestjs/common';
import { BackupObjectsChangedHooks } from '../../shared/application/backup-objects-changed-hooks.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { objectKey, uploadKey } from '../domain/backup-keys.js';
import { INDEX_TAIL_TIMEOUT_MS } from '../domain/backup-limits.js';
import type { BackupObject } from '../domain/backup-object.js';
import { BackupObjectRepository } from '../domain/backup-object.repository.js';
import type {
  BackupObjectVersion,
  PurgedVersion,
} from '../domain/backup-object-version.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { BackupRules } from '../domain/backup-rules.js';
import { BackupObjectHealer, type ObjectRef } from './backup-object-healer.js';
import { BackupTrash } from './backup-trash.js';
import {
  committedVersionView,
  type CommittedVersionView,
} from './dto/backup-views.js';
import { ObjectStore } from './ports/object-store.js';
import { assertStillMarked } from './journal.js';
import {
  type BackupWriteGuard,
  ServerWriteRefusedError,
} from './server-write-guard.js';
import {
  lockTimeoutAsBusy,
  objectVersionConflict,
  uploadNotFound,
} from './storage-errors.js';
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
//    o que falta copiar soma no máximo 5 GiB declarados (422 `confirm-batch-too-large`; o cliente divide o lote);
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
// Espera por trava além de 10 s (`lock_timeout`, posto por `StorageAccess.lock`) = 409 `storage-busy`, repetível.
// Limite de versões antigas por objeto (10, `MAX_TRASH_VERSIONS_PER_OBJECT`; spec §4.8 "Controle da lixeira"): cada
// objeto que ganhou versão nova (inclusive um apagado que volta) tem as substituídas além das 10 mais recentes apagadas de vez (`BackupTrash.capObject`:
// `purged` no índice, sob a trava do objeto, no mesmo unit of work) e, só DEPOIS do COMMIT, apagadas do S3
// (`removeFromBucket`, que nunca falha o pedido: a marca do diário deixa o resto para a varredura).
// Por último, ainda no unit of work, `BackupObjectsChangedHooks` (`committed`, os objetos que ganharam versão).
@Injectable()
export class ConfirmUploadsUseCase {
  constructor(
    private readonly access: StorageAccess,
    private readonly objects: BackupObjectRepository,
    private readonly versions: BackupObjectVersionRepository,
    private readonly store: ObjectStore,
    private readonly healer: BackupObjectHealer,
    private readonly trash: BackupTrash,
    private readonly uow: UnitOfWork,
    private readonly changed: BackupObjectsChangedHooks,
  ) {}

  async execute(
    actor: StorageActor,
    spaceId: string,
    uploadIds: readonly string[],
    now: Date = new Date(),
    server: { guard: BackupWriteGuard } | null = null,
  ): Promise<CommittedVersionView[]> {
    const writing: ObjectRef[] = [];
    let purged: { orgId: string; spaceId: string; versions: PurgedVersion[] } =
      { orgId: '', spaceId: '', versions: [] };
    let views: CommittedVersionView[];
    try {
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
      views = await this.uow.run(async () => {
        const space = await this.access.lock(
          spaceId,
          actor,
          'memory.write',
          'share',
        );
        const orgId = space.organizationId;
        // The server's own write: its precondition, under the space lock (e.g. still in the active cloud).
        if (server && !(await server.guard(space))) {
          throw new ServerWriteRefusedError();
        }
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
        // As cópias correm sob as travas, segurando uma conexão do pool: um pedido copia no máximo 5 GiB declarados.
        BackupRules.assertConfirmBatchSize(
          toCommit.reduce((sum, v) => sum + v.sizeBytes, 0),
        );

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
        const withOldVersions = new Set<string>();
        for (const version of toCommit) {
          const object = locked.get(version.objectId)!;
          object.assertReplaces(version.replacesVersionId);
          version.assertUploaded(
            await this.store.head(uploadKey(orgId, space.spaceId, version.id)),
          );
          // Um objeto apagado que volta também passa pelo limite: o apagar não o aplica e deixou a última versão
          // (e as antigas) na lixeira.
          const revived = object.deletedAt !== null;
          const { supersededVersionId } = object.commit(version.id);
          if (supersededVersionId) superseded.push(supersededVersionId);
          if (supersededVersionId || revived) {
            withOldVersions.add(version.objectId);
          }
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
        // Daqui ao COMMIT só gravações curtas no índice: o carimbo de `updated_at` do objeto (relógio do banco, no
        // `save` abaixo) fica no máximo INDEX_TAIL_TIMEOUT_MS antes do COMMIT, ou a transação morre (o reparo tira as
        // cópias); é o que garante a folga do `since` da listagem.
        await this.uow.limitRemainingTime(INDEX_TAIL_TIMEOUT_MS);
        for (const version of toCommit) await this.versions.save(version);
        // A version committed and replaced in the same request goes to the trash too.
        if (superseded.length > 0) {
          await this.versions.markSuperseded(orgId, superseded);
        }
        // Limite de 10 versões antigas por objeto: as além disso viram `purged` aqui (sob a trava do objeto); o S3 só
        // depois do COMMIT.
        const capped: PurgedVersion[] = [];
        for (const objectId of [...withOldVersions].sort()) {
          capped.push(
            ...(await this.trash.capObject(orgId, space.spaceId, objectId)),
          );
        }
        purged = { orgId, spaceId: space.spaceId, versions: capped };
        // As marcas NÃO são limpas aqui: uma cópia abortada de outra tentativa ainda pode chegar ao S3; só a
        // varredura por idade as limpa, depois de reparar o objeto.
        for (const objectId of objectIds) {
          await this.objects.save(locked.get(objectId)!);
        }
        // Quem reage ao backup (nuvem ativa: enfileira a reindexação) entra nesta transação, sem travar nada.
        await this.changed.run({
          organizationId: orgId,
          spaceId: space.spaceId,
          objectIds,
          change: 'committed',
        });
        return uploadIds.map((id) => committedVersionView(found.get(id)!));
      });
    } catch (error) {
      if (writing.length > 0) await this.healer.repair(writing);
      throw lockTimeoutAsBusy(error);
    }
    await this.trash.removeFromBucket(
      purged.orgId,
      purged.spaceId,
      purged.versions,
    );
    return views;
  }
}
