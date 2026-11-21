import { ConflictError } from '../../shared/domain/errors.js';
import { nextPolicyVersion } from './agent-policy-version.js';

describe('nextPolicyVersion', () => {
  it('is current + 1 when the writer started from the current version', () => {
    expect(nextPolicyVersion(0, 0)).toBe(1);
    expect(nextPolicyVersion(7, 7)).toBe(8);
  });

  it.each([
    [3, 2],
    [3, 4],
    [0, 1],
  ])(
    'is 409 agent-policy-version-stale for current %i and base %i',
    (cur, base) => {
      try {
        nextPolicyVersion(cur, base);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictError);
        expect((e as ConflictError).code).toBe('agent-policy-version-stale');
      }
    },
  );
});
