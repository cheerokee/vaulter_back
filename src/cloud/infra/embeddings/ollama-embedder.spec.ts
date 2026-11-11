import { ConfigService } from '@nestjs/config';
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EmbeddingServiceError,
  OllamaEmbedder,
} from './ollama-embedder.js';

const config = new ConfigService({
  EMBEDDINGS_URL: 'http://embeddings:11434/',
  EMBEDDING_MODEL: 'nomic-embed-text:v1.5',
});
const vector = () => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5);

function fakeFetch(
  handler: (body: { model: string; input: string[] }) => unknown,
  status = 200,
) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as {
      model: string;
      input: string[];
    };
    return new Response(JSON.stringify(handler(body)), { status });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function embedderWith(f: typeof fetch): OllamaEmbedder {
  const e = new OllamaEmbedder(config);
  e.fetchFn = f;
  return e;
}

describe('OllamaEmbedder', () => {
  it('posts the batch to /api/embed with the pinned model and returns vectors, model and tokens', async () => {
    const f = fakeFetch((b) => ({
      embeddings: b.input.map(vector),
      prompt_eval_count: 7,
    }));
    const out = await embedderWith(f).embed(['a', 'b'], 'query');
    expect(f).toHaveBeenCalledOnce();
    expect(f.mock.calls[0]![0]).toBe('http://embeddings:11434/api/embed');
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({
      model: 'nomic-embed-text:v1.5',
      input: ['a', 'b'],
    });
    expect(out).toMatchObject({
      model: 'nomic-embed-text:v1.5',
      dimensions: 768,
      inputTokens: 7,
    });
    expect(out.vectors).toHaveLength(2);
  });

  it('sends the same request for both kinds (no task prefix, like the Hub)', async () => {
    const bodies: string[] = [];
    const f = fakeFetch((b) => {
      bodies.push(JSON.stringify(b));
      return { embeddings: b.input.map(vector) };
    });
    const embedder = embedderWith(f);
    await embedder.embed(['texto'], 'document');
    await embedder.embed(['texto'], 'query');
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).not.toMatch(/search_(document|query)/);
  });

  it('splits into batches, keeps the order and estimates tokens when not reported', async () => {
    const f = fakeFetch((b) => ({
      embeddings: b.input.map((t) => {
        const v = vector();
        v[0] = Number(t);
        return v;
      }),
    }));
    const texts = Array.from({ length: EMBEDDING_BATCH_SIZE + 3 }, (_, i) =>
      String(i),
    );
    const out = await embedderWith(f).embed(texts, 'document');
    expect(f).toHaveBeenCalledTimes(2);
    expect(out.vectors.map((v) => v[0])).toEqual(texts.map(Number));
    expect(out.inputTokens).toBe(texts.length); // 1 token per 1-2 char text
  });

  it('does not call the service for no texts', async () => {
    const f = fakeFetch(() => ({}));
    const out = await embedderWith(f).embed([], 'document');
    expect(f).not.toHaveBeenCalled();
    expect(out.vectors).toEqual([]);
  });

  it('fails without leaking the texts: bad status, wrong count, wrong dimensions', async () => {
    const secret = 'conteudo-secreto-do-cliente';
    for (const f of [
      fakeFetch(() => ({}), 500),
      fakeFetch(() => ({ embeddings: [] })),
      fakeFetch(() => ({ embeddings: [[1, 2, 3]] })),
    ]) {
      const err = await embedderWith(f)
        .embed([secret], 'document')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmbeddingServiceError);
      expect((err as Error).message).not.toContain(secret);
    }
  });
});
