import { ConfigService } from '@nestjs/config';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { LanguageModelError } from '../../application/ports/language-model.js';
import { BedrockLanguageModel } from './bedrock-language-model.js';

const config = new ConfigService({
  CLOUD_LLM_MODEL_ID: 'us.anthropic.claude-test',
  AWS_REGION: 'us-east-1',
});

function model(send: (cmd: ConverseCommand) => unknown) {
  const client = {
    send: vi.fn(async (c: ConverseCommand) => send(c)),
    destroy: vi.fn(),
  };
  return {
    llm: new BedrockLanguageModel(config, client as never),
    client,
  };
}

describe('BedrockLanguageModel', () => {
  it('maps the input to Converse and the answer back (text, usage, model)', async () => {
    const { llm, client } = model(() => ({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Olá ' }, { text: 'mundo' }],
        },
      },
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 3 },
    }));
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
      model: 'us.anthropic.claude-test',
    });
    const sent = client.send.mock.calls[0]![0].input;
    expect(sent).toMatchObject({
      modelId: 'us.anthropic.claude-test',
      system: [{ text: 'sys' }],
      messages: [{ role: 'user', content: [{ text: 'oi' }] }],
      inferenceConfig: { maxTokens: 100 },
    });
    expect(sent.toolConfig).toBeUndefined();
  });

  it('declares tools, returns tool calls and sends tool results back', async () => {
    const { llm, client } = model(() => ({
      output: {
        message: {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 't1',
                name: 'save_document',
                input: { title: 'x' },
              },
            },
          ],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
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
            { type: 'tool_use', id: 't0', name: 'save_document', input: {} },
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
          ],
        },
      ],
      maxTokens: 10,
    });
    expect(out.stopReason).toBe('tool_use');
    expect(out.toolCalls).toEqual([
      { id: 't1', name: 'save_document', input: { title: 'x' } },
    ]);
    const sent = client.send.mock.calls[0]![0].input as any;
    expect(sent.toolConfig.tools[0].toolSpec).toMatchObject({
      name: 'save_document',
      inputSchema: { json: { type: 'object' } },
    });
    expect(sent.messages[1].content[0].toolUse).toMatchObject({
      toolUseId: 't0',
      name: 'save_document',
    });
    expect(sent.messages[2].content[0].toolResult).toMatchObject({
      toolUseId: 't0',
      status: 'error',
      content: [{ text: 'ok' }],
    });
  });

  it('classifies failures as retryable or not, without leaking the request', async () => {
    const secret = 'segredo-do-prompt';
    for (const [name, retryable] of [
      ['ThrottlingException', true],
      ['ValidationException', false],
    ] as const) {
      const { llm } = model(() => {
        const e = new Error(`bad request containing ${secret}`);
        e.name = name;
        throw e;
      });
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
    }
  });

  it('maps max_tokens and unknown stop reasons', async () => {
    for (const [reason, expected] of [
      ['max_tokens', 'max_tokens'],
      ['guardrail_intervened', 'other'],
    ]) {
      const { llm } = model(() => ({
        output: { message: { role: 'assistant', content: [] } },
        stopReason: reason,
        usage: {},
      }));
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
    const { llm, client } = model(() => ({}));
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
    expect(client.send).not.toHaveBeenCalled();
  });

  it('omits an empty system prompt', async () => {
    const { llm, client } = model(() => ({
      output: { message: { role: 'assistant', content: [] } },
      usage: {},
    }));
    await llm.complete({
      system: '',
      messages: [{ role: 'user', content: 'oi' }],
      maxTokens: 1,
    });
    expect(client.send.mock.calls[0]![0].input.system).toBeUndefined();
  });

  it('treats network errors and 5xx as retryable', async () => {
    const make = (props: Record<string, unknown>) => () => {
      throw Object.assign(new Error('x'), props);
    };
    for (const [props, retryable] of [
      [{ code: 'ECONNRESET' }, true],
      [{ name: 'NetworkingError' }, true],
      [{ $metadata: { httpStatusCode: 503 } }, true],
      [{ $metadata: { httpStatusCode: 400 } }, false],
    ] as const) {
      const { llm } = model(make(props));
      const err = await llm
        .complete({ system: 's', messages: [], maxTokens: 1 })
        .catch((e: unknown) => e);
      expect((err as LanguageModelError).retryable).toBe(retryable);
    }
  });
});
