import { AiPricing, UnpricedModelError } from './ai-pricing.js';

const pricing = new AiPricing({
  m: { inputMicroUsdPerMTok: 2_000_000n, outputMicroUsdPerMTok: 10_000_000n },
});

describe('AiPricing', () => {
  it('prices a whole million tokens exactly ($2 in, $10 out)', () => {
    expect(
      pricing.costMicroUsd(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        'm',
      ),
    ).toBe(12_000_000n);
  });

  it('rounds up a partial micro-dollar and never returns zero for real usage', () => {
    // 1 input token = 2 micro-USD; 1 output token = 10 micro-USD
    expect(pricing.costMicroUsd({ inputTokens: 1, outputTokens: 0 }, 'm')).toBe(
      2n,
    );
    const cheap = new AiPricing({
      c: { inputMicroUsdPerMTok: 20_000n, outputMicroUsdPerMTok: 0n },
    });
    expect(cheap.costMicroUsd({ inputTokens: 1, outputTokens: 0 }, 'c')).toBe(
      1n,
    );
    expect(cheap.costMicroUsd({ inputTokens: 0, outputTokens: 0 }, 'c')).toBe(
      0n,
    );
  });

  it('does not lose precision above 2^53 micro-dollars', () => {
    const huge = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER tokens
    expect(
      pricing.costMicroUsd({ inputTokens: huge, outputTokens: 0 }, 'm'),
    ).toBe((BigInt(huge) * 2_000_000n) / 1_000_000n);
  });

  it('fails closed for an unpriced model and for invalid token counts', () => {
    expect(() =>
      pricing.costMicroUsd({ inputTokens: 1, outputTokens: 1 }, 'nope'),
    ).toThrow(UnpricedModelError);
    expect(() =>
      pricing.costMicroUsd({ inputTokens: -1, outputTokens: 0 }, 'm'),
    ).toThrow(RangeError);
    expect(() =>
      pricing.costMicroUsd({ inputTokens: 1.5, outputTokens: 0 }, 'm'),
    ).toThrow(RangeError);
  });

  it('only knows own entries (no prototype lookups) and asserts at boot', () => {
    expect(pricing.has('m')).toBe(true);
    for (const k of ['constructor', '__proto__', 'toString']) {
      expect(pricing.has(k)).toBe(false);
      expect(() =>
        pricing.costMicroUsd({ inputTokens: 1, outputTokens: 0 }, k),
      ).toThrow(UnpricedModelError);
    }
    expect(() => pricing.assertPriced('m')).not.toThrow();
    expect(() => pricing.assertPriced('m', 'other')).toThrow(
      UnpricedModelError,
    );
  });
});
