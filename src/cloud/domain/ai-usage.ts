import { DomainValidationError } from '../../shared/domain/errors.js';

/** What spent AI money (spec active-cloud §4.4: "por espaço e por tipo"). */
export const AI_USAGE_KINDS = ['answer', 'indexing'] as const;
export type AiUsageKind = (typeof AI_USAGE_KINDS)[number];

/**
 * How long a reservation counts against the budget without being settled or released. A process that dies between
 * reserving and settling (crash, deploy) leaves it behind: after this it stops counting (status `expired`), and a late
 * settle still records the real spend. Longer than any single model/embedding call we make (embedding request timeout
 * 120 s; the answer's model call in Task 7 stays far below).
 */
export const AI_RESERVATION_TTL_SECONDS = 15 * 60;

/** A reservation taken by `AiBudget.reserve`: the caller settles it with the real cost or releases it. */
export type AiReservation = {
  id: string;
  organizationId: string;
  spaceId: string;
  kind: AiUsageKind;
  /** First day of the UTC month (database clock) the reservation counts in, `YYYY-MM-01`; its spend stays there. */
  month: string;
  amountMicroUsd: bigint;
};

/** What a model/embedding call really used (never content: model id, token counts, cost). */
export type AiSpend = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: bigint;
};

/** The month's state of an organization's budget, read in ONE statement (one snapshot). */
export type AiBudgetMonth = {
  /** `YYYY-MM-01` (UTC calendar month by the database clock). */
  month: string;
  /** When the month ends (the budget starts again from zero). */
  resetsAt: Date;
  /** Settled spend of the month. */
  spentMicroUsd: bigint;
  /** Live (unexpired, unsettled) reservations of the month. */
  reservedMicroUsd: bigint;
};

/**
 * 422 `ai-budget-exceeded`: the organization's AI budget for this month has no room for the call (spec active-cloud
 * §4.4). Nothing that costs AI runs; the Hub keeps working. `resetsAt` (ISO) says when the month starts again; no
 * amounts (the person asking may not be an admin).
 */
export class AiBudgetExceededError extends DomainValidationError {
  constructor(resetsAt: Date) {
    super(
      'ai-budget-exceeded',
      "The organization's AI budget for this month is exhausted.",
      { resetsAt: resetsAt.toISOString() },
    );
  }
}

/** Whether a reservation of `amount` fits: what is spent and reserved, plus it, within the budget. */
export function reservationFits(
  budgetMicroUsd: bigint,
  month: AiBudgetMonth,
  amountMicroUsd: bigint,
): boolean {
  if (budgetMicroUsd <= 0n) return false;
  return (
    month.spentMicroUsd + month.reservedMicroUsd + amountMicroUsd <=
    budgetMicroUsd
  );
}

/**
 * Upper estimate of the tokens of texts sent to the embedding model, for the reservation (the real count settles it):
 * one token per 2 characters, rounded up per text. WordPiece/BPE tokenizers give about one token per 3-4 characters of
 * Portuguese or English prose, so this over-reserves on purpose (a reservation that is too small would let concurrent
 * calls run past the budget).
 */
export function estimateEmbeddingTokens(texts: readonly string[]): number {
  return texts.reduce((sum, t) => sum + Math.ceil(t.length / 2), 0);
}
