import { ConfigService } from '@nestjs/config';
import { EMBEDDING_DIMENSIONS, OllamaEmbedder } from './ollama-embedder.js';

/**
 * Against the real `embeddings` service of the compose (needs the pinned model pulled, ~274 MB). Skipped unless
 * EMBEDDINGS_REAL_URL is set: CI does not provision the model (everything else uses the fake embedder by DI).
 *   docker exec -e EMBEDDINGS_REAL_URL=http://embeddings:11434 vaulter-back-app \
 *     npx vitest run src/cloud/infra/embeddings/ollama-embedder.real.spec.ts
 */
const url = process.env.EMBEDDINGS_REAL_URL;

describe.runIf(url)('OllamaEmbedder against the real service', () => {
  const embedder = () =>
    new OllamaEmbedder(
      new ConfigService({
        EMBEDDINGS_URL: url,
        EMBEDDING_MODEL: 'nomic-embed-text:v1.5',
      }),
    );

  it('returns 768 dimensions and is deterministic', async () => {
    const texts = ['A nota fiscal vence dia 10.', 'Reunião com o financeiro'];
    const a = await embedder().embed(texts, 'document');
    const b = await embedder().embed(texts, 'document');
    expect(a.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(a.model).toBe('nomic-embed-text:v1.5');
    expect(a.vectors).toHaveLength(2);
    expect(a.vectors.every((v) => v.length === 768)).toBe(true);
    for (let i = 0; i < 768; i += 1) {
      expect(b.vectors[0]![i]).toBeCloseTo(a.vectors[0]![i]!, 5);
    }
    expect(a.inputTokens).toBeGreaterThan(0);
  }, 120_000);

  it('puts a related text closer than an unrelated one (cosine)', async () => {
    const { vectors } = await embedder().embed(
      [
        'Quando vence a nota fiscal do fornecedor?',
        'A nota fiscal do fornecedor vence dia 10.',
        'O gato dormiu no sofá a tarde toda.',
      ],
      'query',
    );
    const dot = (x: number[], y: number[]) =>
      x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(vectors[0]!, vectors[1]!)).toBeGreaterThan(
      dot(vectors[0]!, vectors[2]!),
    );
  }, 120_000);
});
