import { Injectable } from '@nestjs/common';
import { newId } from '../../shared/domain/id.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { uploadKey } from '../domain/backup-keys.js';
import { PRESIGNED_URL_TTL_SECONDS } from '../domain/backup-limits.js';
import { BackupObjectRepository } from '../domain/backup-object.repository.js';
import { BackupObjectVersion } from '../domain/backup-object-version.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { BackupRules } from '../domain/backup-rules.js';
import type {
  UploadIntentInput,
  UploadIntentView,
} from './dto/backup-views.js';
import { ObjectStore } from './ports/object-store.js';
import { objectVersionConflict } from './storage-errors.js';
import {
  StorageAccess,
  type StorageActor,
  uploaderOf,
} from './storage-access.js';

// Intenção de envio (spec storage-backup §4.2, passo 1), tudo ou nada por pedido (até 100 objetos):
// 1. formato: cada objeto uma vez (422 `duplicate-object`), até 5 GiB (422 `object-too-large`), antes de travar nada;
// 2. no unit of work: trava o espaço (`StorageAccess.lock`, `memory.write`; FOR UPDATE, a mesma trava do
//    redimensionar e da troca de chave: duas intenções do mesmo espaço se serializam, senão cada uma caberia sozinha
//    e juntas estourariam o tamanho; nenhuma chamada ao S3 acontece sob ela), confere troca de chave pendente / versão da chave (409), trava cada objeto em
//    ordem de id (criando a linha do objeto novo; id de outro espaço = 409), confere `replacesVersionId` (409
//    `object-version-conflict`), encerra as intenções anteriores do mesmo objeto por quem envia, lê o uso (com as
//    reservas) e confere que tudo cabe (422 `space-storage-full` com `missingBytes`); grava as versões `pending`;
// 3. depois do commit, assina um PUT por objeto no prefixo provisório `uploads/<uploadId>` (15 min), preso ao tamanho
//    e ao sha256 declarados. Os cabeçalhos devolvidos vão ao cliente sem mudança.
@Injectable()
export class RequestUploadsUseCase {
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
    items: readonly UploadIntentInput[],
    now: Date = new Date(),
  ): Promise<UploadIntentView[]> {
    BackupRules.assertDistinctObjects(items.map((i) => i.objectId));
    for (const i of items)
      BackupRules.assertObjectSize(i.objectId, i.sizeBytes);
    const uploader = uploaderOf(actor);

    const created = await this.uow.run(async () => {
      const space = await this.access.lock(
        spaceId,
        actor,
        'memory.write',
        'update',
      );
      const orgId = space.organizationId;
      for (const i of items) BackupRules.assertWritable(space, i.keyVersion);
      const sorted = [...items].sort((a, b) =>
        a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0,
      );
      for (const i of sorted) {
        const object = await this.objects.lockOrCreate(
          orgId,
          space.spaceId,
          i.objectId,
        );
        if (!object) throw objectVersionConflict(i.objectId, null);
        object.assertReplaces(i.replacesVersionId);
        await this.versions.expirePending(
          orgId,
          space.spaceId,
          i.objectId,
          uploader,
        );
      }
      const usedBytes = await this.versions.usedBytes(orgId, space.spaceId);
      BackupRules.assertFits(
        space,
        usedBytes,
        items.reduce((sum, i) => sum + i.sizeBytes, 0),
      );
      const versions = new Map<string, BackupObjectVersion>();
      for (const i of sorted) {
        const version = BackupObjectVersion.request({
          id: newId(),
          organizationId: orgId,
          spaceId: space.spaceId,
          objectId: i.objectId,
          keyVersion: i.keyVersion,
          sizeBytes: i.sizeBytes,
          sha256: i.sha256,
          replacesVersionId: i.replacesVersionId,
          uploader,
          now,
        });
        await this.versions.create(version);
        versions.set(i.objectId, version);
      }
      return { orgId, versions };
    });

    const expiresAt = new Date(
      now.getTime() + PRESIGNED_URL_TTL_SECONDS * 1000,
    );
    const out: UploadIntentView[] = [];
    for (const i of items) {
      const version = created.versions.get(i.objectId)!;
      const { url, headers } = await this.store.presignPut(
        uploadKey(created.orgId, version.spaceId, version.id),
        {
          sizeBytes: version.sizeBytes,
          sha256Hex: version.sha256,
          expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
        },
      );
      out.push({
        objectId: i.objectId,
        uploadId: version.id,
        url,
        headers,
        expiresAt,
      });
    }
    return out;
  }
}
