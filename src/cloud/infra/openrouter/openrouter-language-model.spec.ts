import { ConfigService } from '@nestjs/config';
import { LanguageModelError } from '../../application/ports/language-model.js';
import {
  OPENROUTER_CHAT_URL,
  OpenRouterLanguageModel,
} from './openrouter-language-model.js';

const config = new ConfigService({
  CLOUD_LLM_MODEL_ID: 'anthropic/claude-test',
  OPENROUTER_API_KEY: 'sk-or-test',
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function model(reply: () => Response | Promise<Response>) {
  const llm = new OpenRouterLanguageModel(config);
  const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => reply());
  llm.fetchFn = fetchFn as unknown as typeof fetch;
  const sent = (i = 0) =>
    JSON.parse(fetchFn.mock.calls[i]![1].body as string) as Record<string, any>;
  return { llm, fetchFn, sent };
}

const answer = (message: Record<string, unknown>, extra = {}) =>
  json({
    choices: [{ finish_reason: 'stop', message }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
    ...extra,
  });

describe('OpenRouterLanguageModel', () => {
  it('maps the input to Chat Completions and the answer back (text, usage, model)', async () => {
    const { llm, fetchFn, sent } = model(() =>
      answer({ role: 'assistant', content: 'Olá mundo' }),
    );
    const out = await llm.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'oi' }],
      maxTokens: 100,
    });
    expect(out).toEqual({
      text: 'Olá mundo',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 3 },
      model: 'anthropic/claude-test',
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(OPENROUTER_CHAT_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer sk-or-test',
      'content-type': 'application/json',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(sent()).toEqual({
      model: 'anthropic/claude-test',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'oi' },
      ],
      max_tokens: 100,
      provider: { data_collection: 'deny' },
    });
  });

  it('declares tools, returns tool calls and sends tool calls and results back', async () => {
    const { llm, sent } = model(() =>
      json({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 't1',
                  type: 'function',
                  function: {
                    name: 'save_document',
                    arguments: '{"title":"x"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );
    const out = await llm.complete({
      system: 's',
      tools: [
        {
          name: 'save_document',
          description: 'd',
          inputSchema: { type: 'object' },
        },
      ],
      messages: [
        { role: 'user', content: 'grave' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'vou gravar' },
            { type: 'tool_use', id: 't0', name: 'save_document', input: {} },
            {
              type: 'tool_use',
              id: 't0b',
              name: 'save_document',
              input: { a: 1 },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 't0',
              content: 'ok',
              isError: true,
            },
            { type: 'tool_result', toolUseId: 't0b', content: 'feito' },
          ],
        },
      ],
      maxTokens: 10,
    });
    expect(out.stopReason).toBe('tool_use');
    expect(out.text).toBe('');
    expect(out.toolCalls).toEqual([
      { id: 't1', name: 'save_document', input: { title: 'x' } },
    ]);
    const body = sent();
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'save_document',
          description: 'd',
          parameters: { type: 'object' },
        },
      },
    ]);
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'grave' },
      {
        role: 'assistant',
        content: 'vou gravar',
        tool_calls: [
          {
            id: 't0',
            type: 'function',
            function: { name: 'save_document', arguments: '{}' },
          },
          {
            id: 't0b',
            type: 'function',
            function: { name: 'save_document', arguments: '{"a":1}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 't0', content: 'Error: ok' },
      { role: 'tool', tool_call_id: 't0b', content: 'feito' },
    ]);
  });

  it('an assistant turn with only tool calls has null content', async () => {
    const { llm, sent } = model(() => answer({ content: 'ok' }));
    await llm.complete({
      system: '',
      tools: [{ name: 'x', description: 'd', inputSchema: {} }],
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }],
        },
      ],
      maxTokens: 1,
    });
    expect(sent().messages[0]).toMatchObject({
      role: 'assistant',
      content: null,
    });
  });

  it('omits an empty system prompt and tools when none are passed', async () => {
    const { llm, sent } = model(() => answer({ content: 'x' }));
    await llm.complete({
      system: '',
      messages: [{ role: 'user', content: 'oi' }],
      maxTokens: 1,
    });
    expect(sent().messages).toEqual([{ role: 'user', content: 'oi' }]);
    expect(sent().tools).toBeUndefined();
  });

  it('maps finish reasons and missing usage', async () => {
    for (const [reason, expected] of [
      ['stop', 'end_turn'],
      ['tool_calls', 'tool_use'],
      ['length', 'max_tokens'],
      ['content_filter', 'other'],
      [null, 'other'],
    ] as const) {
      const { llm } = model(() =>
        json({
          choices: [{ finish_reason: reason, message: { content: '' } }],
        }),
      );
      const out = await llm.complete({
        system: '',
        messages: [],
        maxTokens: 1,
      });
      expect(out.stopReason).toBe(expected);
      expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    }
  });

  it('refuses a history with tool blocks when no tools are passed, before any call', async () => {
    const { llm, fetchFn } = model(() => answer({ content: '' }));
    const err = await llm
      .complete({
        system: 's',
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 't', content: 'ok' }],
          },
        ],
        maxTokens: 1,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LanguageModelError);
    expect((err as LanguageModelError).retryable).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('classifies HTTP failures without leaking the request or the error body', async () => {
    const secret = 'segredo-do-prompt';
    for (const [status, retryable] of [
      [429, true],
      [500, true],
      [502, true],
      [503, true],
      [408, true],
      [400, false],
      [401, false],
      [402, false],
      [404, false],
    ] as const) {
      const { llm } = model(() =>
        json({ error: { message: `bad ${secret}`, code: status } }, status),
      );
      const err = await llm
        .complete({
          system: secret,
          messages: [{ role: 'user', content: secret }],
          maxTokens: 1,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LanguageModelError);
      expect((err as LanguageModelError).retryable).toBe(retryable);
      expect((err as Error).message).not.toContain(secret);
      expect((err as Error).message).not.toContain('sk-or-test');
    }
  });

  it('treats network errors and timeouts as retryable', async () => {
    for (const e of [
      new TypeError('fetch failed'),
      Object.assign(new Error('t'), { name: 'TimeoutError' }),
    ]) {
      const { llm } = model(() => {
        throw e;
      });
      const err = await llm
        .complete({ system: 's', messages: [], maxTokens: 1 })
        .catch((x: unknown) => x);
      expect(err).toBeInstanceOf(LanguageModelError);
      expect((err as LanguageModelError).retryable).toBe(true);
    }
  });

  it('an error object in a 200 response is classified by its code', async () => {
    for (const [code, retryable] of [
      [502, true],
      [400, false],
      ['x', true],
    ] as const) {
      const { llm } = model(() => json({ error: { code, message: 'm' } }));
      const err = await llm
        .complete({ system: 's', messages: [], maxTokens: 1 })
        .catch((x: unknown) => x);
      expect((err as LanguageModelError).retryable).toBe(retryable);
    }
  });

  it('a response without a choice is not retryable; malformed tool arguments are', async () => {
    const empty = await model(() => json({ choices: [] }))
      .llm.complete({ system: 's', messages: [], maxTokens: 1 })
      .catch((x: unknown) => x);
    expect(empty).toBeInstanceOf(LanguageModelError);
    expect((empty as LanguageModelError).retryable).toBe(false);

    const bad = await model(() =>
      answer({
        content: null,
        tool_calls: [{ id: 't', function: { name: 'x', arguments: '{oops' } }],
      }),
    )
      .llm.complete({ system: 's', messages: [], maxTokens: 1 })
      .catch((x: unknown) => x);
    expect(bad).toBeInstanceOf(LanguageModelError);
    expect((bad as LanguageModelError).retryable).toBe(true);
  });

  it('a tool call with empty arguments gets an empty input', async () => {
    const out = await model(() =>
      answer({
        content: null,
        tool_calls: [{ id: 't', function: { name: 'x', arguments: '' } }],
      }),
    ).llm.complete({ system: 's', messages: [], maxTokens: 1 });
    expect(out.toolCalls).toEqual([{ id: 't', name: 'x', input: {} }]);
  });
});
