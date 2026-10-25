import { ConflictError } from '../../shared/domain/errors.js';
import { OrphanRules as R } from './orphan.js';

describe('OrphanRules', () => {
  it('assertOrphan passes only with zero active members', () => {
    expect(() => R.assertOrphan(0)).not.toThrow();
    expect(() => R.assertOrphan(1)).toThrowError(ConflictError);
    expect(() => R.assertOrphan(3)).toThrowError(
      expect.objectContaining({ code: 'space-not-orphan' }),
    );
  });

  it('assertNoManager passes only with zero managers', () => {
    expect(() => R.assertNoManager(0)).not.toThrow();
    expect(() => R.assertNoManager(2)).toThrowError(ConflictError);
    expect(() => R.assertNoManager(1)).toThrowError(
      expect.objectContaining({ code: 'space-has-manager' }),
    );
  });
});
