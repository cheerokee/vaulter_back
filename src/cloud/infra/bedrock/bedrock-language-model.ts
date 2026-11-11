import { type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import {
  LanguageModel,
  LanguageModelError,
  type LlmContentBlock,
  type LlmInput,
  type LlmMessage,
  type LlmResult,
  type LlmStopReason,
} from '../../application/ports/language-model.js';

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

const RETRYABLE_ERRORS = new Set([
  'NetworkingError',
  'RequestTimeout',
  'ThrottlingException',
  'ServiceUnavailableException',
  'InternalServerException',
  'ModelTimeoutException',
  'ModelNotReadyException',
  'TimeoutError',
]);

/** Converse API of Amazon Bedrock (Claude, `us-east-1`; IAM role in production, no extra secret). */
export class BedrockLanguageModel
  extends LanguageModel
  implements OnApplicationShutdown
{
  readonly model: string;
  private readonly client: Pick<BedrockRuntimeClient, 'send' | 'destroy'>;

  constructor(
    config: ConfigService,
    // Test seam: a mocked client.
    client?: Pick<BedrockRuntimeClient, 'send' | 'destroy'>,
  ) {
    super();
    this.model = config.getOrThrow<string>('CLOUD_LLM_MODEL_ID');
    this.client =
      client ??
      new BedrockRuntimeClient({
        region: config.getOrThrow<string>('AWS_REGION'),
        // A hung socket must not hold a job worker forever.
        requestHandler: { requestTimeout: 120_000, connectionTimeout: 10_000 },
        // No AWS_ENDPOINT_URL: that one points at LocalStack, which has no Bedrock. Default credential chain (IAM
        // role in production; AWS_* variables of the process in a dev who tries the real model).
      });
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }

  async complete(input: LlmInput): Promise<LlmResult> {
    const hasTools = (input.tools?.length ?? 0) > 0;
    // Converse rejects tool blocks in the history without a `toolConfig`: the caller repeats the tools on every turn.
    if (!hasTools && input.messages.some(hasToolBlocks)) {
      throw new LanguageModelError(false, 'tool-history-requires-tools');
    }
    let out: ConverseCommandOutput;
    try {
      out = (await this.client.send(
        new ConverseCommand({
          modelId: this.model,
          system: input.system ? [{ text: input.system }] : undefined,
          messages: input.messages.map(toBedrockMessage),
          inferenceConfig: { maxTokens: input.maxTokens },
          toolConfig:
            input.tools && input.tools.length > 0
              ? {
                  tools: input.tools.map((t) => ({
                    toolSpec: {
                      name: t.name,
                      description: t.description,
                      inputSchema: {
                        json: t.inputSchema as never,
                      },
                    },
                  })),
                }
              : undefined,
        }),
      )) as ConverseCommandOutput;
    } catch (err) {
      // Only the error class name: the message of a failed call can echo request details.
      const name = err instanceof Error ? err.name : 'UnknownError';
      throw new LanguageModelError(isRetryable(err, name), name);
    }

    const blocks = out.output?.message?.content ?? [];
    const text = blocks
      .map((b) => b.text)
      .filter((t): t is string => typeof t === 'string')
      .join('');
    const toolCalls = blocks.flatMap((b) =>
      b.toolUse?.toolUseId && b.toolUse.name
        ? [
            {
              id: b.toolUse.toolUseId,
              name: b.toolUse.name,
              input: (b.toolUse.input ?? {}) as Record<string, unknown>,
            },
          ]
        : [],
    );
    return {
      text,
      toolCalls,
      stopReason: toStopReason(out.stopReason),
      usage: {
        inputTokens: out.usage?.inputTokens ?? 0,
        outputTokens: out.usage?.outputTokens ?? 0,
      },
      model: this.model,
    };
  }
}

function toStopReason(reason: string | undefined): LlmStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'other';
  }
}

function toBedrockMessage(message: LlmMessage): Message {
  const blocks: LlmContentBlock[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
  return { role: message.role, content: blocks.map(toBedrockBlock) };
}

function toBedrockBlock(block: LlmContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { text: block.text };
    case 'tool_use':
      return {
        toolUse: {
          toolUseId: block.id,
          name: block.name,
          input: block.input as never,
        },
      };
    case 'tool_result':
      return {
        toolResult: {
          toolUseId: block.toolUseId,
          content: [{ text: block.content }],
          status: block.isError ? 'error' : 'success',
        },
      };
  }
}

function hasToolBlocks(message: LlmMessage): boolean {
  return (
    typeof message.content !== 'string' &&
    message.content.some((b) => b.type !== 'text')
  );
}

function isRetryable(err: unknown, name: string): boolean {
  if (RETRYABLE_ERRORS.has(name)) return true;
  const e = err as {
    code?: unknown;
    $metadata?: { httpStatusCode?: number };
  } | null;
  if (typeof e?.code === 'string' && RETRYABLE_CODES.has(e.code)) return true;
  const status = e?.$metadata?.httpStatusCode;
  return typeof status === 'number' && (status >= 500 || status === 429);
}
