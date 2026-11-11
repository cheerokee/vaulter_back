import { Injectable, Logger } from '@nestjs/common';
import { newId } from '../../../shared/domain/id.js';
import {
  cloudManifestObjectId,
  hubManifestObjectId,
} from '../../../shared/domain/space-manifest-ids.js';
import { UnitOfWork } from '../../../shared/infra/db/unit-of-work.js';
import { SpaceCloud } from '../../../spaces/application/space-cloud.js';
import type { LiveObjectVersion } from '../../../storage/application/backup-content-reader.js';
import {
  mergeManifests,
  planIndexSync,
  type DesiredFile,
} from '../../domain/cloud-file.js';
import {
  CloudChunkRepository,
  CloudFileRepository,
} from '../../domain/indexing.repositories.js';
import { MANIFEST_MAX_BYTES } from '../../domain/indexing-limits.js';
import {
  ManifestFormatError,
  parseSpaceManifest,
  type ManifestFile,
  type ManifestWriter,
} from '../../domain/space-manifest.js';
import { BackupObjectOpenError } from '../ports/backup-object-opener.js';
import { BackupPlaintextReader } from './backup-plaintext-reader.js';
import {
  CloudIndexingQueue,
  type IndexSpacePayload,
} from './cloud-indexing-queue.js';
import { SpaceKeyOpener, type SpaceKeys } from './space-keys.js';

type ManifestRead =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'ok'; files: ManifestFile[] };

const sameVersions = (
  a: ReadonlyMap<string, LiveObjectVersion>,
  b: ReadonlyMap<string, LiveObjectVersion>,
): boolean =>
  a.size === b.size &&
  [...a].every(([id, v]) => b.get(id)?.versionId === v.versionId);

// Reindexação de um espaço a partir dos manifestos (spec active-cloud §4.2; contrato em docs/hubs/space-manifest.md),
// enfileirada ao ligar e a cada mudança do backup do espaço (`BackupObjectsChangedHooks`). Idempotente.
// 1. Fora de transação: espaço em `active_cloud` (senão nada), versões vivas dos dois manifestos (o do Hub e o da
//    nuvem), lidas pela versão do índice e abertas com a chave do espaço; um manifesto que não abre ou não segue o
//    contrato para a passada inteira (o índice fica como estava; registro só com ids e um código). Versões vivas de
//    todas as partes.
// 2. Uma transação: espaço FOR SHARE (`lockActiveForWrite`: desligou = nada é gravado) -> arquivos do espaço FOR UPDATE
//    (serializa com outra passada e com os jobs de arquivo) -> as versões vivas dos manifestos e das partes relidas: se
//    mudaram desde o passo 1, para (a mudança já enfileirou outra passada, que vê o estado novo; esta nunca regride o
//    índice). Aplica o plano (`planIndexSync`): apaga o que saiu dos manifestos (com os trechos), tira os trechos de
//    arquivo com parte faltando, grava os novos/alterados como `pending` e enfileira um `cloud.index-file` por arquivo
//    pendente, na mesma transação.
// Nada legível vai para log (só ids e contagens). A chave aberta é apagada no fim.
@Injectable()
export class IndexSpaceJob {
  private readonly logger = new Logger(IndexSpaceJob.name);

  constructor(
    private readonly spaceCloud: SpaceCloud,
    private readonly keyOpener: SpaceKeyOpener,
    private readonly reader: BackupPlaintextReader,
    private readonly files: CloudFileRepository,
    private readonly chunks: CloudChunkRepository,
    private readonly queue: CloudIndexingQueue,
    private readonly uow: UnitOfWork,
  ) {}

  async run({ organizationId, spaceId }: IndexSpacePayload): Promise<void> {
    if (
      (await this.spaceCloud.modeOf(organizationId, spaceId)) !== 'active_cloud'
    ) {
      return;
    }
    const manifestIds = {
      hub: hubManifestObjectId(spaceId),
      cloud: cloudManifestObjectId(spaceId),
    };
    const manifestVersions = await this.reader.liveVersions(
      organizationId,
      spaceId,
      [manifestIds.hub, manifestIds.cloud],
    );
    const keys = await this.keyOpener.forSpace(organizationId, spaceId);
    let hub: ManifestRead;
    let cloud: ManifestRead;
    try {
      hub = await this.readManifest(
        organizationId,
        spaceId,
        'hub',
        manifestVersions.get(manifestIds.hub),
        keys,
      );
      cloud = await this.readManifest(
        organizationId,
        spaceId,
        'cloud',
        manifestVersions.get(manifestIds.cloud),
        keys,
      );
    } finally {
      keys.wipe();
    }
    if (hub.kind === 'invalid' || cloud.kind === 'invalid') return;

    const merged = mergeManifests(
      hub.kind === 'ok' ? hub.files : [],
      cloud.kind === 'ok' ? cloud.files : [],
    );
    const partIds = merged.flatMap((m) => m.entry.parts);
    const partVersions = await this.reader.liveVersions(
      organizationId,
      spaceId,
      partIds,
    );
    const desired: DesiredFile[] = merged.map(({ entry, manifest }) => {
      const parts = entry.parts.map((objectId) => {
        const v = partVersions.get(objectId);
        return v ? { objectId, versionId: v.versionId } : null;
      });
      return {
        entry,
        manifest,
        parts: parts.every((p) => p !== null) ? parts : null,
      };
    });

    await this.uow.run(async () => {
      if (
        !(await this.spaceCloud.lockActiveForWrite(organizationId, spaceId))
      ) {
        return;
      }
      const existing = await this.files.lockForSpace(organizationId, spaceId);
      // Releitura sob as travas: uma passada mais nova (outra instância) já pode ter gravado um estado mais recente.
      const nowManifests = await this.reader.liveVersions(
        organizationId,
        spaceId,
        [manifestIds.hub, manifestIds.cloud],
      );
      const nowParts = await this.reader.liveVersions(
        organizationId,
        spaceId,
        partIds,
      );
      if (
        !sameVersions(manifestVersions, nowManifests) ||
        !sameVersions(partVersions, nowParts)
      ) {
        return;
      }
      const plan = planIndexSync(
        { organizationId, spaceId },
        existing,
        desired,
        newId,
      );
      await this.files.deleteByIds(
        organizationId,
        plan.remove.map((f) => f.id),
      );
      for (const f of plan.clearChunks) {
        await this.chunks.deleteForFile(organizationId, f.id);
      }
      for (const f of plan.upsert) await this.files.upsert(f);
      for (const id of plan.enqueue) {
        await this.queue.enqueueFile(organizationId, spaceId, id);
      }
      this.logger.log(
        {
          organizationId,
          spaceId,
          files: desired.length,
          removed: plan.remove.length,
          changed: plan.upsert.length,
          enqueued: plan.enqueue.length,
        },
        'cloud space reindexed',
      );
    });
  }

  private async readManifest(
    organizationId: string,
    spaceId: string,
    writer: ManifestWriter,
    version: LiveObjectVersion | undefined,
    keys: SpaceKeys,
  ): Promise<ManifestRead> {
    if (!version) return { kind: 'absent' };
    if (version.sizeBytes > MANIFEST_MAX_BYTES) {
      this.refused(organizationId, spaceId, writer, 'too-large');
      return { kind: 'invalid' };
    }
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = await this.reader.open(
        organizationId,
        spaceId,
        version,
        keys,
        MANIFEST_MAX_BYTES,
      );
      const manifest = parseSpaceManifest(plaintext, { spaceId, writer });
      if (manifest.skippedEntries > 0) {
        this.logger.warn(
          {
            organizationId,
            spaceId,
            manifest: writer,
            skippedEntries: manifest.skippedEntries,
          },
          'space manifest entries skipped',
        );
      }
      return { kind: 'ok', files: manifest.files };
    } catch (error) {
      if (error instanceof ManifestFormatError) {
        this.refused(organizationId, spaceId, writer, error.reason);
        return { kind: 'invalid' };
      }
      if (error instanceof BackupObjectOpenError) {
        this.refused(organizationId, spaceId, writer, error.reason);
        return { kind: 'invalid' };
      }
      throw error;
    } finally {
      plaintext?.fill(0);
    }
  }

  private refused(
    organizationId: string,
    spaceId: string,
    manifest: ManifestWriter,
    reason: string,
  ): void {
    this.logger.warn(
      { organizationId, spaceId, manifest, reason },
      'space manifest refused; the index is kept as it was',
    );
  }
}
