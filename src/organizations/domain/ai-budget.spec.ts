import {
  aiBudgetState,
  aiBudgetWarningLevel,
  assertAiBudget,
} from './ai-budget.js';

describe('AI budget', () => {
  it('warning level: 0 below 75 %, then 75, 90 and 100 at or beyond the budget', () => {
    expect(aiBudgetWarningLevel(1000n, 0n)).toBe(0);
    expect(aiBudgetWarningLevel(1000n, 749n)).toBe(0);
    expect(aiBudgetWarningLevel(1000n, 750n)).toBe(75);
    expect(aiBudgetWarningLevel(1000n, 899n)).toBe(75);
    expect(aiBudgetWarningLevel(1000n, 900n)).toBe(90);
    expect(aiBudgetWarningLevel(1000n, 999n)).toBe(90);
    expect(aiBudgetWarningLevel(1000n, 1000n)).toBe(100);
    expect(aiBudgetWarningLevel(1000n, 5000n)).toBe(100);
  });

  it('a budget of 0 is "not configured" and level 100 (nothing runs)', () => {
    expect(aiBudgetState(0n, 0n)).toEqual({
      budgetConfigured: false,
      warningLevel: 100,
    });
    expect(aiBudgetState(10n, 1n)).toEqual({
      budgetConfigured: true,
      warningLevel: 0,
    });
  });

  it('accepts 0..2^53-1 micro-USD only', () => {
    expect(assertAiBudget(0n)).toBe(0n);
    expect(assertAiBudget(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
    expect(() => assertAiBudget(-1n)).toThrow(/non-negative/);
    expect(() =>
      assertAiBudget(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    ).toThrow();
  });
});
