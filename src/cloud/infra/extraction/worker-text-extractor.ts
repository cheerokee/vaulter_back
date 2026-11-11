import { existsSync } from 'node:fs';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Piscina } from 'piscina';
import {
  TextExtractor,
  type ExtractionResult,
} from '../../application/ports/text-extractor.js';
import {
  EXTRACTED_TEXT_MAX_CHARS,
  EXTRACTION_TIMEOUT_MS,
  EXTRACTION_WORKER_HEAP_MB,
  ZIP_ENTRY_MAX_BYTES,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_RATIO,
  ZIP_TOTAL_MAX_BYTES,
} from '../../domain/indexing-limits.js';
import {
  SUPPORTED_MEDIA_TYPES,
  type ExtractionJob,
  type WorkerExtractionResult,
} from './text-extraction.worker.js';

/** Compiled .js in dist/, .ts when running from sources (Vitest). */
function workerFile(): URL {
  const js = new URL('./text-extraction.worker.js', import.meta.url);
  return existsSync(js)
    ? js
    : new URL('./text-extraction.worker.ts', import.meta.url);
}

const LIMITS: ExtractionJob['limits'] = {
  maxChars: EXTRACTED_TEXT_MAX_CHARS,
  zipMaxEntries: ZIP_MAX_ENTRIES,
  zipEntryMaxBytes: ZIP_ENTRY_MAX_BYTES,
  zipTotalMaxBytes: ZIP_TOTAL_MAX_BYTES,
  zipMaxRatio: ZIP_MAX_RATIO,
};

// Extração em thread separada (piscina; worker em `text-extraction.worker.ts`): parsear um PDF de 100 MiB ou um arquivo
// hostil nunca trava o event loop da API. Uma thread (a fila `cloud.index-file` roda um job por vez por processo),
// criada sob demanda e encerrada ociosa; limite de tempo (`EXTRACTION_TIMEOUT_MS`: o piscina encerra a thread) e de
// heap (`EXTRACTION_WORKER_HEAP_MB`: o V8 derruba a thread). Tempo esgotado, memória esgotada ou a thread caindo viram
// `unreadable` com um código (`extract-timeout`, `extract-memory`, `extract-crashed`): terminal até uma versão nova do
// arquivo. Os bytes vão para a thread transferidos (uma cópia; quem chama apaga o original, a thread apaga a cópia).
@Injectable()
export class WorkerTextExtractor
  extends TextExtractor
  implements OnApplicationShutdown
{
  private pool?: Piscina;
  private destroyed = false;
  /** Wall-clock limit per file (tests lower it). */
  timeoutMs = EXTRACTION_TIMEOUT_MS;

  supports(mediaType: string): boolean {
    return SUPPORTED_MEDIA_TYPES.includes(mediaType);
  }

  async extract(
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<ExtractionResult> {
    if (!this.supports(mediaType)) return { kind: 'unsupported' };
    const copy = new Uint8Array(bytes);
    const job: ExtractionJob = { mediaType, bytes: copy, limits: LIMITS };
    try {
      return (await this.getPool().run(job, {
        signal: AbortSignal.timeout(this.timeoutMs),
        transferList: [copy.buffer as ArrayBuffer],
      })) as WorkerExtractionResult;
    } catch (error) {
      return { kind: 'unreadable', reason: failureReason(error) };
    } finally {
      // Transferred: detached here (the worker wipes it); if the run never started, wipe it now.
      if (copy.byteLength > 0) copy.fill(0);
    }
  }

  /** After the job workers drained (application shutdown). */
  async onApplicationShutdown(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    this.destroyed = true;
    await pool?.destroy();
  }

  private getPool(): Piscina {
    if (this.destroyed)
      throw new Error('WorkerTextExtractor has been destroyed');
    this.pool ??= new Piscina({
      filename: workerFile().href,
      minThreads: 0,
      maxThreads: 1,
      idleTimeout: 60_000,
      resourceLimits: { maxOldGenerationSizeMb: EXTRACTION_WORKER_HEAP_MB },
    });
    return this.pool;
  }
}

function failureReason(error: unknown): string {
  const e = error as { name?: string; code?: string } | null;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return 'extract-timeout';
  }
  if (e?.code === 'ERR_WORKER_OUT_OF_MEMORY') return 'extract-memory';
  return 'extract-crashed';
}
