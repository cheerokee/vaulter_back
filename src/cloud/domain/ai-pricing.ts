import { DomainError } from '../../shared/domain/errors.js';

/**
 * Price table of the AI usage, in micro-USD (1e-6 USD) per million tokens. USD per million tokens x 1_000_000, so
 * "$2.00 / 1M tokens" is 2_000_000n. Integer math only (bigint): the monthly budget is a bigint of micro-USD.
 *
 * THE VALUES BELOW ARE PLACEHOLDERS: Jonas decides the real ones (Bedrock list prices for the model in
 * `CLOUD_LLM_MODEL_ID`, and what we charge). Changing a price changes how fast budgets run out, never what was already
 * recorded (usage rows keep the cost they were measured at).
 */
export interface ModelPrice {
  inputMicroUsdPerMTok: bigint;
  outputMicroUsdPerMTok: bigint;
}

export const DEFAULT_PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  // Claude on Bedrock (placeholder: Sonnet-class list price, $2 in / $10 out per MTok).
  'us.anthropic.claude-sonnet-5-5': {
    inputMicroUsdPerMTok: 2_000_000n,
    outputMicroUsdPerMTok: 10_000_000n,
  },
  // Claude through OpenRouter (CLOUD_LLM_DRIVER=openrouter, development only): OpenRouter's list price for the slug
  // ($2 in / $10 out per MTok, from https://openrouter.ai/api/v1/models on 2026-11-11), so a dev test spends the budget
  // like production would.
  'anthropic/claude-sonnet-5.5': {
    inputMicroUsdPerMTok: 2_000_000n,
    outputMicroUsdPerMTok: 10_000_000n,
  },
  // Our own embedding service (Ollama on our infra): no per-token bill, so a nominal $0.02 / MTok that stands for
  // the compute, so indexing consumes the budget like everything else (placeholder).
  'nomic-embed-text:v1.5': {
    inputMicroUsdPerMTok: 20_000n,
    outputMicroUsdPerMTok: 0n,
  },
  // Test doubles (src/cloud/testing): round numbers, so e2e can exhaust a budget on purpose.
  'fake-llm': {
    inputMicroUsdPerMTok: 1_000_000n,
    outputMicroUsdPerMTok: 5_000_000n,
  },
  'fake-embedding': {
    inputMicroUsdPerMTok: 100_000n,
    outputMicroUsdPerMTok: 0n,
  },
};

/** A model with no price is a programming/configuration error: fail closed, never "free". */
export class UnpricedModelError extends DomainError {
  constructor(model: string) {
    super('ai-model-unpriced', `no price configured for model "${model}"`, {
      model,
    });
  }
}

const MILLION = 1_000_000n;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function assertTokenCount(n: number): bigint {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError('token count must be a non-negative integer');
  }
  return BigInt(n);
}

/**
 * Cost of a usage, rounded UP to a whole micro-USD per call (never under-count against the budget; the error is below
 * 1e-6 USD per call).
 */
export class AiPricing {
  constructor(
    private readonly table: Readonly<
      Record<string, ModelPrice>
    > = DEFAULT_PRICE_TABLE,
  ) {}

  has(model: string): boolean {
    return Object.hasOwn(this.table, model);
  }

  /** Boot check: a model without a price must stop the app, not fail after a billed call. */
  assertPriced(...models: string[]): void {
    for (const m of models) if (!this.has(m)) throw new UnpricedModelError(m);
  }

  private priceOf(model: string): ModelPrice {
    const price = Object.hasOwn(this.table, model)
      ? this.table[model]
      : undefined;
    if (!price) throw new UnpricedModelError(model);
    return price;
  }

  /** Cost of a language model call or an embedding call (`outputTokens` 0). */
  costMicroUsd(
    usage: { inputTokens: number; outputTokens: number },
    model: string,
  ): bigint {
    const price = this.priceOf(model);
    const inTokens = assertTokenCount(usage.inputTokens);
    const outTokens = assertTokenCount(usage.outputTokens);
    return ceilDiv(
      inTokens * price.inputMicroUsdPerMTok +
        outTokens * price.outputMicroUsdPerMTok,
      MILLION,
    );
  }
}
