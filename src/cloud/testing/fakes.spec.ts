import { AiPricing } from '../domain/ai-pricing.js';
import { FakeEmbedder, FAKE_EMBEDDING_MODEL } from './fake-embedder.js';
import { FakeLanguageModel, FAKE_LLM_MODEL } from './fake-language-model.js';

const dot = (a: number[], b: number[]) =>
  a.reduce((s, v, i) => s + v * b[i]!, 0);

describe('FakeEmbedder', () => {
  it('is deterministic, 768-dim, unit length, and ranks shared words higher', async () => {
    const e = new FakeEmbedder();
    const a = await e.embed(
      [
        'nota fiscal vence dia 10',
        'o gato dormiu no sofá',
        'quando vence a nota fiscal',
      ],
      'document',
    );
    const b = await e.embed(['nota fiscal vence dia 10'], 'query');
    expect(a.dimensions).toBe(768);
    expect(a.vectors[0]).toEqual(b.vectors[0]);
    expect(dot(a.vectors[0]!, a.vectors[0]!)).toBeCloseTo(1, 6);
    expect(dot(a.vectors[2]!, a.vectors[0]!)).toBeGreaterThan(
      dot(a.vectors[2]!, a.vectors[1]!),
    );
    expect(
      (await e.embed([''], 'query')).vectors[0]!.every(Number.isFinite),
    ).toBe(true);
  });
});

describe('FakeLanguageModel', () => {
  it('answers by default, reports usage and records calls', async () => {
    const llm = new FakeLanguageModel();
    const out = await llm.complete({
      system: 's',
      messages: [{ role: 'user', content: 'oi' }],
      maxTokens: 10,
    });
    expect(out.text).toBe('fake answer: oi');
    expect(out.usage.inputTokens).toBeGreaterThan(0);
    expect(llm.calls).toHaveLength(1);
  });

  it('plays scripted tool calls then a final answer, and scripted failures', async () => {
    const llm = new FakeLanguageModel().enqueue(
      {
        toolCalls: [{ id: 't1', name: 'save_document', input: { title: 'x' } }],
        usage: { inputTokens: 1000, outputTokens: 500 },
      },
      { text: 'gravado' },
      { error: new Error('boom') },
    );
    const input = { system: '', messages: [], maxTokens: 1 };
    const first = await llm.complete(input);
    expect(first.stopReason).toBe('tool_use');
    expect(first.toolCalls[0]!.name).toBe('save_document');
    expect(first.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
    expect((await llm.complete(input)).text).toBe('gravado');
    await expect(llm.complete(input)).rejects.toThrow('boom');
  });

  it('the fake models are priced', () => {
    const p = new AiPricing();
    expect(
      p.costMicroUsd(
        { inputTokens: 1_000_000, outputTokens: 0 },
        FAKE_LLM_MODEL,
      ),
    ).toBe(1_000_000n);
    expect(
      p.costMicroUsd(
        { inputTokens: 1_000_000, outputTokens: 0 },
        FAKE_EMBEDDING_MODEL,
      ),
    ).toBe(100_000n);
  });
});
