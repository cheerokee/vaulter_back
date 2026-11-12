import { ConfigService } from '@nestjs/config';
import {
  LanguageModel,
  LanguageModelError,
  type LlmContentBlock,
  type LlmInput,
  type LlmMessage,
  type LlmResult,
  type LlmStopReason,
  type LlmToolCall,
} from '../../application/ports/language-model.js';

export const OPENROUTER_CHAT_URL =
  'https://openrouter.ai/api/v1/chat/completions';
/** Same as the Bedrock adapter: a hung socket must not hold a job worker forever. */
export const OPENROUTER_TIMEOUT_MS = 120_000;

/** OpenAI-compatible chat message, as OpenRouter takes it. */
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatResponse {
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: {
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { code?: number | string };
}

/**
 * Claude through OpenRouter's OpenAI-compatible Chat Completions API. DEVELOPMENT ONLY (`CLOUD_LLM_DRIVER=openrouter`,
 * refused in production): lets a dev try the responder with a real model without an AWS account. The content (prompt,
 * space chunks, conversation) leaves our infrastructure to OpenRouter and the model provider, so only test data.
 * `CLOUD_LLM_MODEL_ID` is the OpenRouter slug (e.g. `anthropic/claude-sonnet-5.5`), priced in `AiPricing`.
 */
export class OpenRouterLanguageModel extends LanguageModel {
  readonly model: string;
  private readonly apiKey: string;

  /** Test seam (not a constructor parameter, like `OllamaEmbedder`). */
  fetchFn: typeof fetch = fetch;

  constructor(config: ConfigService) {
    super();
    this.model = config.getOrThrow<string>('CLOUD_LLM_MODEL_ID');
    this.apiKey = config.getOrThrow<string>('OPENROUTER_API_KEY');
  }

  async complete(input: LlmInput): Promise<LlmResult> {
    const hasTools = (input.tools?.length ?? 0) > 0;
    // Same rule as Bedrock (the port is one contract): the caller repeats the tools on every turn.
    if (!hasTools && input.messages.some(hasToolBlocks)) {
      throw new LanguageModelError(false, 'tool-history-requires-tools');
    }
    const body = {
      model: this.model,
      messages: [
        ...(input.system
          ? [{ role: 'system', content: input.system } as ChatMessage]
          : []),
        ...input.messages.flatMap(toChatMessages),
      ],
      max_tokens: input.maxTokens,
      ...(hasTools
        ? {
            tools: input.tools!.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              },
            })),
          }
        : {}),
      // Only providers that do not keep the prompts (OpenRouter provider routing).
      provider: { data_collection: 'deny' },
    };

    let response: Response;
    try {
      response = await this.fetchFn(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error, abort or timeout. Only the error class name: never the request.
      throw new LanguageModelError(
        true,
        err instanceof Error ? err.name : 'request-failed',
      );
    }
    if (!response.ok) {
      // The error body may echo the request: never read into the error.
      throw new LanguageModelError(
        isRetryableStatus(response.status),
        `http-${response.status}`,
      );
    }
    let out: ChatResponse;
    try {
      out = (await response.json()) as ChatResponse;
    } catch {
      throw new LanguageModelError(true, 'malformed-response');
    }
    // OpenRouter may answer 200 with an error object (an upstream failure mid-request).
    if (out.error) {
      const code = Number(out.error.code);
      throw new LanguageModelError(
        Number.isInteger(code) ? isRetryableStatus(code) : true,
        `upstream-${Number.isInteger(code) ? code : 'error'}`,
      );
    }
    const choice = out.choices?.[0];
    if (!choice?.message) {
      throw new LanguageModelError(false, 'malformed-response');
    }
    return {
      text: choice.message.content ?? '',
      toolCalls: (choice.message.tool_calls ?? []).flatMap(toToolCall),
      stopReason: toStopReason(choice.finish_reason),
      usage: {
        inputTokens: out.usage?.prompt_tokens ?? 0,
        outputTokens: out.usage?.completion_tokens ?? 0,
      },
      model: this.model,
    };
  }
}

function toToolCall(call: {
  id?: string;
  function?: { name?: string; arguments?: string };
}): LlmToolCall[] {
  if (!call.id || !call.function?.name) return [];
  let input: unknown = {};
  const raw = call.function.arguments;
  if (raw && raw.trim() !== '') {
    try {
      input = JSON.parse(raw);
    } catch {
      // A model slip: another attempt usually produces valid JSON.
      throw new LanguageModelError(true, 'invalid-tool-arguments');
    }
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new LanguageModelError(true, 'invalid-tool-arguments');
  }
  return [
    {
      id: call.id,
      name: call.function.name,
      input: input as Record<string, unknown>,
    },
  ];
}

function toStopReason(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

/**
 * One port message -> OpenAI messages. A user message's tool results become `role: tool` messages (right after the
 * assistant turn that called them, as OpenAI requires), then its text, if any. An assistant message carries its text
 * and its `tool_calls`. A failed tool result has no flag in OpenAI's format: it is marked in the content.
 */
function toChatMessages(message: LlmMessage): ChatMessage[] {
  const blocks: LlmContentBlock[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
  const text = blocks
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('');
  if (message.role === 'assistant') {
    const calls = blocks.flatMap((b) =>
      b.type === 'tool_use'
        ? [
            {
              id: b.id,
              type: 'function' as const,
              function: { name: b.name, arguments: JSON.stringify(b.input) },
            },
          ]
        : [],
    );
    return [
      {
        role: 'assistant',
        content: text === '' && calls.length > 0 ? null : text,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      },
    ];
  }
  const results: ChatMessage[] = blocks.flatMap((b) =>
    b.type === 'tool_result'
      ? [
          {
            role: 'tool' as const,
            tool_call_id: b.toolUseId,
            content: b.isError ? `Error: ${b.content}` : b.content,
          },
        ]
      : [],
  );
  const hasText = blocks.some((b) => b.type === 'text');
  return [
    ...results,
    ...(hasText || results.length === 0
      ? [{ role: 'user' as const, content: text }]
      : []),
  ];
}

function hasToolBlocks(message: LlmMessage): boolean {
  return (
    typeof message.content !== 'string' &&
    message.content.some((b) => b.type !== 'text')
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
