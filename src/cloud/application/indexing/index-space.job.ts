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
import {
  INDEX_SPACE_BATCH_FILES,
  INDEX_SPACE_BATCH_PARTS,
  INDEX_SPACE_BATCH_TIMEOUT_MS,
  INDEX_SPACE_LOCK_TIMEOUT_MS,
  MANIFEST_MAX_BYTES,
} from '../../domain/indexing-limits.js';
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

/** The same version of every id in `ids` (absent in both counts as the same). */
const sameVersionsOf = (
  ids: Iterable<string>,
  a: ReadonlyMap<string, LiveObjectVersion>,
  b: ReadonlyMap<string, LiveObjectVersion>,
): boolean => {
  for (const id of ids) {
    if (a.get(id)?.versionId !== b.get(id)?.versionId) return false;
  }
  return true;
};

type Batch = { fileIds: string[]; partIds: string[] };

/** Every fileId (listed or known) in order, cut in batches of at most N files and M parts. */
function batchesOf(
  fileIds: readonly string[],
  partsOf: (fileId: string) => readonly string[],
): Batch[] {
  const batches: Batch[] = [];
  let current: Batch = { fileIds: [], partIds: [] };
  for (const fileId of [...new Set(fileIds)].sort()) {
    const parts = partsOf(fileId);
    if (
      current.fileIds.length > 0 &&
      (current.fileIds.length >= INDEX_SPACE_BATCH_FILES ||
        current.partIds.length + parts.length > INDEX_SPACE_BATCH_PARTS)
    ) {
      batches.push(current);
      current = { fileIds: [], partIds: [] };
    }
    current.fileIds.push(fileId);
    current.partIds.push(...parts);
  }
  if (current.fileIds.length > 0) batches.push(current);
  return batches;
}

type BatchOutcome = 'done' | 'switched-off' | 'changed';

// Reindexação de um espaço a partir dos manifestos (spec active-cloud §4.2; contrato em docs/hubs/space-manifest.md),
// enfileirada ao ligar e a cada mudança do backup do espaço (`BackupObjectsChangedHooks`). Idempotente.
// 1. Fora de transação (nenhuma trava): espaço em `active_cloud` (senão nada); versões vivas dos dois manifestos (o do
//    Hub e o da nuvem), lidas pela versão do índice e abertas com a chave do espaço (um manifesto que não abre ou não
//    segue o contrato para a passada inteira: o índice fica como estava; registro só com ids e um código); entradas
//    unidas (`mergeManifests`, com a guarda de partes compartilhadas); versões vivas de todas as partes; os arquivos que
//    a nuvem já conhece (`listForSpace`, sem trava).
// 2. Lotes de até 500 arquivos / 2000 partes, cada um numa transação CURTA e de custo fixo (Review do fix round 1: a
//    trava do espaço nunca fica presa por O(arquivos)): `lock_timeout` 10 s e `transaction_timeout` 30 s -> espaço
//    FOR SHARE (`lockActiveForWrite`: desligou = para, nada gravado; Review Focus 1) -> versões dos manifestos e das
//    partes do lote relidas (mudaram desde o passo 1 = para: a mudança já enfileirou outra passada, que vê o estado
//    novo; esta nunca regride o índice) -> SÓ os arquivos do lote FOR UPDATE (serializa com os jobs de arquivo) ->
//    plano do lote (`planIndexSync`) aplicado em comandos em lote: apagar o que saiu, tirar os trechos de arquivo com
//    parte faltando, um upsert de todos os alterados (por `(space_id, file_id)`: duas passadas iguais em instâncias
//    diferentes gravam o mesmo), um INSERT de todos os `cloud.index-file`. Entre os lotes nada fica travado.
// Nada legível vai para log (só ids e contagens). A chave aberta é apagada no fim da leitura dos manifestos.
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
    const manifestIds = [
      hubManifestObjectId(spaceId),
      cloudManifestObjectId(spaceId),
    ];
    const manifestVersions = await this.reader.liveVersions(
      organizationId,
      spaceId,
      manifestIds,
    );
    const keys = await this.keyOpener.forSpace(organizationId, spaceId);
    let hub: ManifestRead;
    let cloud: ManifestRead;
    try {
      hub = await this.readManifest(
        organizationId,
        spaceId,
        'hub',
        manifestVersions.get(manifestIds[0]!),
        keys,
      );
      cloud = await this.readManifest(
        organizationId,
        spaceId,
        'cloud',
        manifestVersions.get(manifestIds[1]!),
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
    if (merged.droppedSharedParts > 0) {
      this.logger.warn(
        {
          organizationId,
          spaceId,
          droppedEntries: merged.droppedSharedParts,
          reason: 'shared-parts',
        },
        'space manifest entries skipped',
      );
    }
    const partVersions = await this.reader.liveVersions(
      organizationId,
      spaceId,
      merged.files.flatMap((m) => m.entry.parts),
    );
    const desired = new Map<string, DesiredFile>();
    for (const { entry, manifest } of merged.files) {
      const parts = entry.parts.map((objectId) => {
        const v = partVersions.get(objectId);
        return v ? { objectId, versionId: v.versionId } : null;
      });
      desired.set(entry.fileId, {
        entry,
        manifest,
        parts: parts.every((p) => p !== null) ? parts : null,
      });
    }
    const known = await this.files.listForSpace(organizationId, spaceId);
    const batches = batchesOf(
      [...desired.keys(), ...known.map((f) => f.fileId)],
      (fileId) => desired.get(fileId)?.entry.parts ?? [],
    );

    const totals = { removed: 0, changed: 0, enqueued: 0 };
    for (const batch of batches) {
      const outcome = await this.applyBatch(
        { organizationId, spaceId },
        batch,
        desired,
        { manifestIds, manifestVersions, partVersions },
        totals,
      );
      if (outcome !== 'done') return;
    }
    this.logger.log(
      {
        organizationId,
        spaceId,
        files: desired.size,
        batches: batches.length,
        ...totals,
      },
      'cloud space reindexed',
    );
  }

  private applyBatch(
    scope: { organizationId: string; spaceId: string },
    batch: Batch,
    desired: ReadonlyMap<string, DesiredFile>,
    snapshot: {
      manifestIds: string[];
      manifestVersions: ReadonlyMap<string, LiveObjectVersion>;
      partVersions: ReadonlyMap<string, LiveObjectVersion>;
    },
    totals: { removed: number; changed: number; enqueued: number },
  ): Promise<BatchOutcome> {
    const { organizationId, spaceId } = scope;
    return this.uow.run(async () => {
      await this.uow.setLockTimeout(INDEX_SPACE_LOCK_TIMEOUT_MS);
      await this.uow.limitRemainingTime(INDEX_SPACE_BATCH_TIMEOUT_MS);
      if (
        !(await this.spaceCloud.lockActiveForWrite(organizationId, spaceId))
      ) {
        return 'switched-off';
      }
      const nowManifests = await this.reader.liveVersions(
        organizationId,
        spaceId,
        snapshot.manifestIds,
      );
      const nowParts = await this.reader.liveVersions(
        organizationId,
        spaceId,
        batch.partIds,
      );
      if (
        !sameVersionsOf(
          snapshot.manifestIds,
          snapshot.manifestVersions,
          nowManifests,
        ) ||
        !sameVersionsOf(batch.partIds, snapshot.partVersions, nowParts)
      ) {
        return 'changed';
      }
      const rows = await this.files.lockByFileIds(
        organizationId,
        spaceId,
        batch.fileIds,
      );
      const plan = planIndexSync(
        scope,
        rows,
        batch.fileIds.flatMap((id) => {
          const d = desired.get(id);
          return d ? [d] : [];
        }),
        newId,
      );
      await this.files.deleteByIds(
        organizationId,
        plan.remove.map((f) => f.id),
      );
      await this.chunks.deleteForFiles(
        organizationId,
        plan.clearChunks.map((f) => f.id),
      );
      const idsByFileId = await this.files.upsertMany(plan.upsert);
      const upserted = new Map(plan.upsert.map((f) => [f.id, f.fileId]));
      const enqueue = plan.enqueue.map((id) => {
        const fileId = upserted.get(id);
        return (fileId && idsByFileId.get(fileId)) ?? id;
      });
      await this.queue.enqueueFiles(organizationId, spaceId, enqueue);
      totals.removed += plan.remove.length;
      totals.changed += plan.upsert.length;
      totals.enqueued += enqueue.length;
      return 'done';
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
