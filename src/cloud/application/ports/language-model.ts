/** A tool the model may call (JSON Schema for the input). */
export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmContentBlock =
  | { type: 'text'; text: string }
  | ({ type: 'tool_use' } & LlmToolCall)
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmContentBlock[];
}

export interface LlmInput {
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

export interface LlmResult {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  model: string;
}

/** The model could not answer. `retryable` = worth retrying later (throttling, timeout, 5xx). Never carries prompt text. */
export class LanguageModelError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly reason: string,
  ) {
    super(`language model failed: ${reason}`);
    this.name = 'LanguageModelError';
  }
}

/**
 * The language model behind the cloud's answers (Claude on Amazon Bedrock in production; a scripted fake in tests).
 * One call = one turn: when `toolCalls` is not empty the caller runs the tools and calls again with the results.
 * Implementations never log prompts, messages or completions.
 */
export abstract class LanguageModel {
  /** Model id, as priced by `AiPricing`. */
  abstract readonly model: string;
  abstract complete(input: LlmInput): Promise<LlmResult>;
}
