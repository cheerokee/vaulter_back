import { CloudTermRules, type CloudTerm } from './cloud-term.js';

const term: CloudTerm = {
  version: 2,
  hash: 'a'.repeat(64),
  text: 't',
  publishedAt: new Date('2026-11-10T00:00:00Z'),
};

describe('CloudTermRules', () => {
  it('accepts only the current version with the hash of the text shown', () => {
    expect(CloudTermRules.assertAcceptsCurrent(term, 2, 'a'.repeat(64))).toBe(
      term,
    );
    for (const [v, h] of [
      [1, 'a'.repeat(64)],
      [2, 'b'.repeat(64)],
    ] as const) {
      expect(() => CloudTermRules.assertAcceptsCurrent(term, v, h)).toThrow(
        expect.objectContaining({
          code: 'cloud-terms-outdated',
          details: { currentVersion: 2 },
        }),
      );
    }
    expect(() =>
      CloudTermRules.assertAcceptsCurrent(null, 1, 'a'.repeat(64)),
    ).toThrow(expect.objectContaining({ code: 'cloud-terms-outdated' }));
  });

  it('authorizing needs the acceptance of the CURRENT version (a new term must be accepted again)', () => {
    const accepted = (termVersion: number) => ({
      organizationId: 'o',
      termVersion,
      termHash: 'x'.repeat(64),
      acceptedByUserId: 'u',
      acceptedAt: new Date(),
    });
    expect(CloudTermRules.assertCurrentAccepted(term, accepted(2))).toBe(term);
    for (const a of [null, accepted(1)]) {
      expect(() => CloudTermRules.assertCurrentAccepted(term, a)).toThrow(
        expect.objectContaining({ code: 'cloud-terms-not-accepted' }),
      );
    }
  });
});
