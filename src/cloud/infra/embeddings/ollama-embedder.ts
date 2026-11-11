import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Embedder,
  type EmbeddingKind,
  type EmbeddingResult,
} from '../../application/ports/embedder.js';

export const EMBEDDING_DIMENSIONS = 768;
/** Texts per request to the service (chunks are ~800 chars; keeps a request small and its failure cheap to retry). */
export const EMBEDDING_BATCH_SIZE = 32;
export const EMBEDDING_TIMEOUT_MS = 120_000;

/** The embedding service failed or answered something unusable. Never carries the texts. */
export class EmbeddingServiceError extends Error {
  constructor(reason: string) {
    super(`embedding service failed: ${reason}`);
    this.name = 'EmbeddingServiceError';
  }
}

/**
 * `Embedder` over Ollama's `POST /api/embed` (service `embeddings` of the compose; version and model pinned there).
 * `/api/embed` batches and returns L2-normalized vectors; the Hub uses the older per-text `/api/embeddings`, whose
 * vectors are the same direction without the normalization, so cosine similarity (the only distance we use) is
 * comparable between cloud and Hub. No task prefix, on purpose: see `Embedder`.
 */
@Injectable()
export class OllamaEmbedder extends Embedder {
  private readonly baseUrl: string;
  private readonly model: string;

  /** Test seam (not a constructor parameter: Nest would try to inject it). */
  fetchFn: typeof fetch = fetch;

  constructor(config: ConfigService) {
    super();
    this.baseUrl = config
      .getOrThrow<string>('EMBEDDINGS_URL')
      .replace(/\/+$/, '');
    this.model = config.getOrThrow<string>('EMBEDDING_MODEL');
  }

  async embed(
    texts: readonly string[],
    // Same treatment for both kinds today (see the port).
    _kind: EmbeddingKind,
  ): Promise<EmbeddingResult> {
    const vectors: number[][] = [];
    let inputTokens = 0;
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
      const out = await this.embedBatch(batch);
      vectors.push(...out.vectors);
      inputTokens += out.inputTokens;
    }
    return {
      vectors,
      model: this.model,
      dimensions: EMBEDDING_DIMENSIONS,
      inputTokens,
    };
  }

  private async embedBatch(
    batch: readonly string[],
  ): Promise<{ vectors: number[][]; inputTokens: number }> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: batch }),
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
      });
    } catch (err) {
      throw new EmbeddingServiceError(
        err instanceof Error ? err.name : 'request failed',
      );
    }
    if (!response.ok) {
      throw new EmbeddingServiceError(`status ${response.status}`);
    }
    const body = (await response.json()) as {
      embeddings?: unknown;
      prompt_eval_count?: unknown;
    };
    const vectors = body.embeddings;
    if (
      !Array.isArray(vectors) ||
      vectors.length !== batch.length ||
      !vectors.every(
        (v) =>
          Array.isArray(v) &&
          v.length === EMBEDDING_DIMENSIONS &&
          v.every((x) => typeof x === 'number' && Number.isFinite(x)),
      )
    ) {
      throw new EmbeddingServiceError('unexpected response shape');
    }
    const reported = body.prompt_eval_count;
    const inputTokens =
      typeof reported === 'number' && Number.isFinite(reported) && reported >= 0
        ? Math.ceil(reported)
        : batch.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    return { vectors: vectors as number[][], inputTokens };
  }
}
