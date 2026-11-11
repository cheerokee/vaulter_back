import { createHash } from 'node:crypto';
import {
  Embedder,
  type EmbeddingKind,
  type EmbeddingResult,
} from '../application/ports/embedder.js';

export const FAKE_EMBEDDING_MODEL = 'fake-embedding';
export const FAKE_EMBEDDING_DIMENSIONS = 768;

/**
 * Deterministic bag-of-words embedder for tests (no service, no model): each lowercase word adds +-1 to a dimension
 * chosen by its hash; the vector is L2-normalized. Same text = same vector; texts sharing words have a high cosine,
 * so retrieval e2e can assert "the right chunk comes first". Tokens = ceil(chars / 4).
 */
export class FakeEmbedder extends Embedder {
  readonly calls: { count: number; kind: EmbeddingKind }[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async embed(
    texts: readonly string[],
    kind: EmbeddingKind,
  ): Promise<EmbeddingResult> {
    this.calls.push({ count: texts.length, kind });
    return {
      vectors: texts.map(embedText),
      model: FAKE_EMBEDDING_MODEL,
      dimensions: FAKE_EMBEDDING_DIMENSIONS,
      inputTokens: texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
    };
  }
}

export function embedText(text: string): number[] {
  const vector = Array.from({ length: FAKE_EMBEDDING_DIMENSIONS }, () => 0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) {
    const h = createHash('sha256').update(word).digest();
    const index = h.readUInt16BE(0) % FAKE_EMBEDDING_DIMENSIONS;
    vector[index] = (vector[index] ?? 0) + (h[2]! & 1 ? 1 : -1);
  }
  const norm = Math.sqrt(vector.reduce((s, x) => s + x * x, 0));
  if (norm === 0) {
    vector[0] = 1; // empty text: a fixed unit vector, never NaN
    return vector;
  }
  return vector.map((x) => x / norm);
}
