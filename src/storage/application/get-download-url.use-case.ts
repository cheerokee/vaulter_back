import { Injectable } from '@nestjs/common';
import { objectKey } from '../domain/backup-keys.js';
import { PRESIGNED_URL_TTL_SECONDS } from '../domain/backup-limits.js';
import { BackupIndexReader } from './ports/backup-index-reader.js';
import { ObjectStore } from './ports/object-store.js';
import { versionNotFound } from './storage-errors.js';
import { StorageAccess, type StorageActor } from './storage-access.js';

export type DownloadUrlView = { url: string; expiresAt: Date };

// URL assinada de GET de UMA versão (spec storage-backup §4.3): a viva ou uma da lixeira (30 dias, relógio do banco).
// Quem: Hub com o espaço na Sala (qualquer papel) ou membro com `memory.read`; o resto 404 `space-not-found`, sem
// trava. A versão do S3 vem SEMPRE do índice (`s3_version_id`), nunca da versão "atual" do S3. Versão desconhecida,
// pendente, de outro objeto/espaço ou fora da lixeira: 404 `version-not-found`. A URL vale 15 min e não é revogável:
// quem perde o acesso (tirado da Sala, desvinculado, saiu do espaço) guarda só a que já tinha até ela vencer.
@Injectable()
export class GetDownloadUrlUseCase {
  constructor(
    private readonly access: StorageAccess,
    private readonly reader: BackupIndexReader,
    private readonly store: ObjectStore,
  ) {}

  async execute(
    actor: StorageActor,
    spaceId: string,
    objectId: string,
    versionId: string,
    now: Date = new Date(),
  ): Promise<DownloadUrlView> {
    const space = await this.access.require(spaceId, actor, 'memory.read');
    const s3VersionId = await this.reader.downloadableS3VersionId(
      space.organizationId,
      space.spaceId,
      objectId,
      versionId,
    );
    if (!s3VersionId) throw versionNotFound(objectId, versionId);
    // From a clock read before signing: the URL works at least until the announced `expiresAt` (a few ms more).
    const expiresAt = new Date(
      now.getTime() + PRESIGNED_URL_TTL_SECONDS * 1000,
    );
    const url = await this.store.presignGet(
      objectKey(space.organizationId, space.spaceId, objectId),
      s3VersionId,
      PRESIGNED_URL_TTL_SECONDS,
    );
    return { url, expiresAt };
  }
}
