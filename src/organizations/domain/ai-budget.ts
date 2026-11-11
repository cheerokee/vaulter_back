import { DomainValidationError } from '../../shared/domain/errors.js';

/**
 * Monthly AI budget of an organization (spec active-cloud §4.4), in micro-USD (1e-6 USD), like the GitHub Actions
 * budget. Default 0: the active cloud is a contracted service and the platform's finance sets the value. Nothing that
 * costs AI (cloud answers, cloud indexing) runs while the month's spend reaches the budget.
 */
export const AI_BUDGET_DEFAULT_MICRO_USD = 0n;

/** Largest budget the API accepts (JSON numbers are exact up to 2^53 - 1: about US$ 9 billion). */
export const AI_BUDGET_MAX_MICRO_USD = BigInt(Number.MAX_SAFE_INTEGER);

/** Warning thresholds shown to the app (percent of the month's budget already spent or reserved). */
export const AI_BUDGET_WARNING_LEVELS = [75, 90, 100] as const;
export type AiBudgetWarningLevel =
  0 | (typeof AI_BUDGET_WARNING_LEVELS)[number];

export function assertAiBudget(microUsd: bigint): bigint {
  if (
    typeof microUsd !== 'bigint' ||
    microUsd < 0n ||
    microUsd > AI_BUDGET_MAX_MICRO_USD
  ) {
    throw new DomainValidationError(
      'ai-budget-invalid',
      'The AI budget must be a non-negative number of micro-USD.',
    );
  }
  return microUsd;
}

/**
 * The highest threshold reached by `consumed` (spent + live reservations of the month): 0, 75, 90 or 100. A budget of 0
 * is 100 (nothing runs); `consumed` at or beyond the budget is 100.
 */
export function aiBudgetWarningLevel(
  budgetMicroUsd: bigint,
  consumedMicroUsd: bigint,
): AiBudgetWarningLevel {
  if (budgetMicroUsd <= 0n || consumedMicroUsd >= budgetMicroUsd) return 100;
  const percentTimesBudget = consumedMicroUsd * 100n;
  if (percentTimesBudget >= budgetMicroUsd * 90n) return 90;
  if (percentTimesBudget >= budgetMicroUsd * 75n) return 75;
  return 0;
}

/** What every member of an organization sees (`GET /organizations/:id`): no amounts, only the state. */
export type OrganizationAiBudgetState = {
  /** False while the budget is 0 (the AI is not contracted): the app says so instead of "exhausted". */
  budgetConfigured: boolean;
  warningLevel: AiBudgetWarningLevel;
};

export function aiBudgetState(
  budgetMicroUsd: bigint,
  consumedMicroUsd: bigint,
): OrganizationAiBudgetState {
  return {
    budgetConfigured: budgetMicroUsd > 0n,
    warningLevel: aiBudgetWarningLevel(budgetMicroUsd, consumedMicroUsd),
  };
}
