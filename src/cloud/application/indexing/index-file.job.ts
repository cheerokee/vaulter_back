import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../../shared/infra/db/unit-of-work.js';
import { SpaceCloud } from '../../../spaces/application/space-cloud.js';
import type { LiveObjectVersion } from '../../../storage/application/backup-content-reader.js';
import { AiPricing } from '../../domain/ai-pricing.js';
import {
  sameParts,
  type CloudFile,
  type CloudFileSkipReason,
} from '../../domain/cloud-file.js';
import {
  CloudChunkRepository,
  CloudFileRepository,
  type NewChunk,
} from '../../domain/indexing.repositories.js';
import {
  BACKUP_BLOB_OVERHEAD_BYTES,
  EMBEDDING_BATCH,
  INDEXED_FILE_MAX_BYTES,
} from '../../domain/indexing-limits.js';
import { chunkText } from '../../domain/text-chunker.js';
import { BackupObjectOpenError } from '../ports/backup-object-opener.js';
import { Embedder, EmbeddingServiceError } from '../ports/embedder.js';
import {
  IndexingCostMeter,
  type IndexingCharge,
  type IndexingUsage,
} from '../ports/indexing-cost-meter.js';
import { TextExtractor } from '../ports/text-extractor.js';
import { BackupPlaintextReader } from './backup-plaintext-reader.js';
import type { IndexFilePayload } from './cloud-indexing-queue.js';
import { SpaceKeyOpener } from './space-keys.js';

/** Dimensions of the `cloud_chunks.embedding` column (`nomic-embed-text`). */
const EMBEDDING_DIMENSIONS = 768;

type Outcome =
  | { kind: 'indexed'; model: string; chunks: NewChunk[] }
  | { kind: 'skipped'; reason: CloudFileSkipReason; detail?: string };

/**
 * The AI budget refused a batch: the job stops without writing (the file stays `pending`); the budget meter already
 * scheduled the resume. Not an error for pg-boss (caught in `run`).
 */
class IndexingPausedError extends Error {
  constructor() {
    super('indexing paused: AI budget exhausted');
    this.name = 'IndexingPausedError';
  }
}

/** The job stopped before writing (the worker is shutting down / the job expired): pg-boss retries it later. */
export class IndexingAbortedError extends Error {
  constructor() {
    super('indexing aborted');
    this.name = 'IndexingAbortedError';
  }
}

// Indexação de UM arquivo (`cloud_files`, status `pending`), enfileirada pela passada do espaço (`IndexSpaceJob`).
// Idempotente; "pelo menos uma vez".
// 1. Fora de transação: o arquivo ainda `pending`, o espaço em `active_cloud`, cada parte ainda na versão que a passada
//    gravou (senão para: outra passada cuida). Tamanho (soma das partes decifradas) até 100 MiB, formato suportado (senão
//    `skipped` com o motivo e um registro só com ids e o tipo, nunca o nome). Lê cada parte pela versão do índice, abre
//    com a chave do espaço, junta na ordem; extrai o texto; divide em trechos (`chunkText`); embeddings em lotes de 32,
//    pelo `IndexingCostMeter`: ANTES do primeiro lote reserva o custo estimado do ARQUIVO INTEIRO no orçamento de IA
//    (não cabe: o arquivo fica `pending`, nada é chamado nem gravado e a retomada já está agendada; Review Focus 3 —
//    nenhum lote pago é jogado fora numa pausa); a cada lote seguinte renova a reserva (`keepAlive`); no fim acerta o
//    custo real `AiPricing` das chamadas feitas (também se o job falhar no meio) ou devolve a reserva se nenhuma foi
//    feita. Nenhuma transação nem conexão do pool segurada enquanto isso (cada reserva/acerto é uma transação curta).
// 2. Uma transação curta (Review Focus 1): espaço FOR SHARE (`lockActiveForWrite`) -> se desligou, NADA é gravado
//    (desligar trava o espaço FOR UPDATE e apaga arquivos e trechos: ou ele esperou este COMMIT e apaga o que entrou,
//    ou este job o esperou e vê o espaço desligado) -> o arquivo FOR UPDATE (sumiu, deixou de estar `pending` ou mudou
//    de partes: nada) -> troca os trechos do arquivo e grava o estado.
// Chaves e textos em claro são apagados da memória no fim (os buffers; as strings do texto extraído não têm como).
@Injectable()
export class IndexFileJob {
  private readonly logger = new Logger(IndexFileJob.name);

  constructor(
    private readonly spaceCloud: SpaceCloud,
    private readonly keyOpener: SpaceKeyOpener,
    private readonly reader: BackupPlaintextReader,
    private readonly extractor: TextExtractor,
    private readonly embedder: Embedder,
    private readonly costMeter: IndexingCostMeter,
    private readonly pricing: AiPricing,
    private readonly files: CloudFileRepository,
    private readonly chunks: CloudChunkRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async run(
    { organizationId, spaceId, cloudFileId }: IndexFilePayload,
    signal?: AbortSignal,
  ): Promise<void> {
    const file = await this.files.findById(organizationId, cloudFileId);
    if (!file || file.spaceId !== spaceId || file.status !== 'pending') return;
    if (
      (await this.spaceCloud.modeOf(organizationId, spaceId)) !== 'active_cloud'
    ) {
      return;
    }
    const live = await this.reader.liveVersions(
      organizationId,
      spaceId,
      file.parts.map((p) => p.objectId),
    );
    const versions: LiveObjectVersion[] = [];
    for (const p of file.parts) {
      const v = live.get(p.objectId);
      if (!v || v.versionId !== p.versionId) return;
      versions.push(v);
    }
    let outcome: Outcome;
    try {
      outcome = await this.indexOutcome(file, versions, signal);
    } catch (error) {
      if (error instanceof IndexingPausedError) return;
      throw error;
    }
    if (signal?.aborted) throw new IndexingAbortedError();
    await this.write(file, outcome);
  }

  private async indexOutcome(
    file: CloudFile,
    versions: LiveObjectVersion[],
    signal: AbortSignal | undefined,
  ): Promise<Outcome> {
    const plainBytes = versions.reduce(
      (sum, v) => sum + Math.max(0, v.sizeBytes - BACKUP_BLOB_OVERHEAD_BYTES),
      0,
    );
    if (plainBytes > INDEXED_FILE_MAX_BYTES) {
      return { kind: 'skipped', reason: 'too-large' };
    }
    if (!this.extractor.supports(file.mediaType)) {
      return { kind: 'skipped', reason: 'unsupported-format' };
    }
    const plaintext = await this.readFile(file, versions);
    if (!plaintext) return { kind: 'skipped', reason: 'unreadable' };
    let text: string;
    try {
      const extracted = await this.extractor.extract(file.mediaType, plaintext);
      if (extracted.kind === 'unsupported') {
        return { kind: 'skipped', reason: 'unsupported-format' };
      }
      if (extracted.kind === 'unreadable') {
        return {
          kind: 'skipped',
          reason: 'unreadable',
          detail: extracted.reason,
        };
      }
      text = extracted.text;
    } finally {
      plaintext.fill(0);
    }
    const pieces = chunkText(text);
    if (pieces.length === 0) return { kind: 'skipped', reason: 'empty' };
    return this.embed(file, pieces, signal);
  }

  /** The decrypted parts joined in order, or null when one does not open (wrong key, tampered blob). */
  private async readFile(
    file: CloudFile,
    versions: LiveObjectVersion[],
  ): Promise<Uint8Array | null> {
    const keys = await this.keyOpener.forSpace(
      file.organizationId,
      file.spaceId,
    );
    const parts: Uint8Array[] = [];
    try {
      for (const v of versions) {
        parts.push(
          await this.reader.open(
            file.organizationId,
            file.spaceId,
            v,
            keys,
            INDEXED_FILE_MAX_BYTES + BACKUP_BLOB_OVERHEAD_BYTES,
          ),
        );
      }
      if (parts.length === 1) return parts.pop()!;
      const joined = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let at = 0;
      for (const p of parts) {
        joined.set(p, at);
        at += p.length;
      }
      return joined;
    } catch (error) {
      if (error instanceof BackupObjectOpenError) return null;
      throw error;
    } finally {
      keys.wipe();
      for (const p of parts) p.fill(0);
    }
  }

  private async embed(
    file: CloudFile,
    pieces: string[],
    signal: AbortSignal | undefined,
  ): Promise<Outcome> {
    const scope = {
      organizationId: file.organizationId,
      spaceId: file.spaceId,
      cloudFileId: file.id,
    };
    if (signal?.aborted) throw new IndexingAbortedError();
    // The WHOLE file is reserved before the first batch (fix round 1 of Task 5): a file that does not fit in what is
    // left of the month never starts, so no paid batch is ever thrown away by a pause.
    const charge = await this.costMeter.reserve(scope, pieces);
    if (!charge) throw new IndexingPausedError();
    const chunks: NewChunk[] = [];
    let model: string | null = null;
    let inputTokens = 0;
    let costMicroUsd = 0n;
    let calls = 0;
    try {
      for (let i = 0; i < pieces.length; i += EMBEDDING_BATCH) {
        if (signal?.aborted) throw new IndexingAbortedError();
        if (i > 0) await this.costMeter.keepAlive(charge);
        const batch = pieces.slice(i, i + EMBEDDING_BATCH);
        const result = await this.embedder.embed(batch, 'document');
        // The call was made: its real cost counts even if the answer is unusable.
        calls += 1;
        inputTokens += result.inputTokens;
        costMicroUsd += this.pricing.costMicroUsd(
          { inputTokens: result.inputTokens, outputTokens: 0 },
          result.model,
        );
        if (
          result.dimensions !== EMBEDDING_DIMENSIONS ||
          result.vectors.length !== batch.length ||
          result.vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS) ||
          (model !== null && result.model !== model)
        ) {
          throw new EmbeddingServiceError(false, 'unexpected-shape');
        }
        model = result.model;
        batch.forEach((text, j) =>
          chunks.push({ position: i + j, text, embedding: result.vectors[j]! }),
        );
      }
    } catch (error) {
      await this.closeCharge(scope, charge, calls, {
        model: model ?? this.embedder.model,
        inputTokens,
        costMicroUsd,
      });
      throw error;
    }
    await this.closeCharge(scope, charge, calls, {
      model: model!,
      inputTokens,
      costMicroUsd,
    });
    this.logger.log(
      {
        organizationId: file.organizationId,
        spaceId: file.spaceId,
        cloudFileId: file.id,
        chunks: chunks.length,
        inputTokens,
        costMicroUsd: costMicroUsd.toString(),
      },
      'cloud file embedded',
    );
    return { kind: 'indexed', model: model!, chunks };
  }

  /**
   * Settles what the calls made really cost, or gives the reservation back when no call was made. Never masks the
   * job's own outcome: a ledger failure is logged (ids and amounts only) and the reservation expires on its own.
   */
  private async closeCharge(
    scope: { organizationId: string; spaceId: string; cloudFileId: string },
    charge: IndexingCharge,
    calls: number,
    usage: IndexingUsage,
  ): Promise<void> {
    try {
      if (calls === 0) await this.costMeter.release(charge);
      else await this.costMeter.settle(charge, usage);
    } catch (error) {
      this.logger.error(
        {
          ...scope,
          reservationId: charge.reservationId,
          calls,
          inputTokens: usage.inputTokens,
          costMicroUsd: usage.costMicroUsd.toString(),
          error: error instanceof Error ? error.name : 'unknown',
        },
        calls === 0
          ? 'cloud indexing reservation not released'
          : 'cloud indexing spend not recorded',
      );
    }
  }

  private async write(file: CloudFile, outcome: Outcome): Promise<void> {
    const written = await this.uow.run(async () => {
      if (
        !(await this.spaceCloud.lockActiveForWrite(
          file.organizationId,
          file.spaceId,
        ))
      ) {
        return false;
      }
      const row = await this.files.lockById(file.organizationId, file.id);
      if (
        !row ||
        row.status !== 'pending' ||
        !sameParts(row.parts, file.parts)
      ) {
        return false;
      }
      if (outcome.kind === 'indexed') {
        await this.chunks.replaceForFile(row, outcome.model, outcome.chunks);
      } else {
        await this.chunks.deleteForFile(row.organizationId, row.id);
      }
      await this.files.upsert({
        ...row,
        status: outcome.kind === 'indexed' ? 'indexed' : 'skipped',
        skipReason: outcome.kind === 'indexed' ? null : outcome.reason,
        embeddingModel: outcome.kind === 'indexed' ? outcome.model : null,
        chunkCount: outcome.kind === 'indexed' ? outcome.chunks.length : 0,
        indexedAt: new Date(),
      });
      return true;
    });
    if (written && outcome.kind === 'skipped') {
      // Ids, the media type (already normalized by the manifest parser) and a reason code: never the name or path.
      this.logger.warn(
        {
          organizationId: file.organizationId,
          spaceId: file.spaceId,
          cloudFileId: file.id,
          // Only a supported (fixed) type is logged: a free-form one from the manifest could carry content.
          mediaType: this.extractor.supports(file.mediaType)
            ? file.mediaType
            : 'other',
          reason: outcome.reason,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
        },
        'cloud file not indexed',
      );
    }
  }
}
