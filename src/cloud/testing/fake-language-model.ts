import {
  LanguageModel,
  type LlmInput,
  type LlmResult,
  type LlmToolCall,
  type LlmUsage,
} from '../application/ports/language-model.js';

export const FAKE_LLM_MODEL = 'fake-llm';

export interface ScriptedTurn {
  text?: string;
  /** Tool calls the "model" makes this turn (ends the turn with `tool_use`). */
  toolCalls?: LlmToolCall[];
  /** Overrides the computed usage (to exhaust a budget on purpose). */
  usage?: LlmUsage;
  /** Makes this turn fail instead (`LanguageModelError` is the caller's concern: any Error works). */
  error?: Error;
}

/**
 * Deterministic `LanguageModel` for tests. Scripted turns (`enqueue`) are consumed in order, which is how Task 7's e2e
 * drives "record document" tool calls; with an empty script it answers `fake answer: <last user text>` (no tools).
 * Usage is computed (ceil(chars / 4) tokens) unless a turn overrides it. `calls` keeps the inputs for assertions.
 */
export class FakeLanguageModel extends LanguageModel {
  readonly model = FAKE_LLM_MODEL;
  readonly calls: LlmInput[] = [];
  private readonly script: ScriptedTurn[] = [];

  enqueue(...turns: ScriptedTurn[]): this {
    this.script.push(...turns);
    return this;
  }

  reset(): void {
    this.calls.length = 0;
    this.script.length = 0;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async complete(input: LlmInput): Promise<LlmResult> {
    this.calls.push(structuredClone(input));
    const turn = this.script.shift();
    if (turn?.error) throw turn.error;

    const toolCalls = turn?.toolCalls ?? [];
    const text = turn
      ? (turn.text ?? '')
      : `fake answer: ${lastUserText(input)}`;
    const usage = turn?.usage ?? {
      inputTokens: Math.ceil(
        (input.system.length + JSON.stringify(input.messages).length) / 4,
      ),
      outputTokens: Math.ceil(
        (text.length + JSON.stringify(toolCalls).length) / 4,
      ),
    };
    return {
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage,
      model: this.model,
    };
  }
}

function lastUserText(input: LlmInput): string {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const m = input.messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    return m.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
  }
  return '';
}
