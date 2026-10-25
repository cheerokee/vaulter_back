import { ConflictError } from '../../shared/domain/errors.js';
import { KeyRotationRules as R } from './key-rotation.js';

const code = (c: string) => expect.objectContaining({ code: c });

describe('KeyRotationRules', () => {
  it('grants must equal the active members (order-insensitive)', () => {
    expect(() =>
      R.assertGrantsMatchMembers(['b', 'a'], ['a', 'b']),
    ).not.toThrow();
    expect(() => R.assertGrantsMatchMembers([], [])).not.toThrow();
  });

  it.each([
    [['a'], ['a', 'b']],
    [
      ['a', 'b', 'c'],
      ['a', 'b'],
    ],
    [
      ['a', 'a'],
      ['a', 'b'],
    ],
    [['a', 'a'], ['a']],
    [
      ['a', 'c'],
      ['a', 'b'],
    ],
  ])('rejects grants %j vs members %j', (g, m) => {
    expect(() => R.assertGrantsMatchMembers(g, m)).toThrowError(ConflictError);
    expect(() => R.assertGrantsMatchMembers(g, m)).toThrowError(
      code('key-rotation-mismatch'),
    );
  });

  it('grants must cover exactly the existing versions', () => {
    expect(() =>
      R.assertGrantsCoverVersions([2, 1, 3], [1, 2, 3]),
    ).not.toThrow();
  });

  it.each([
    [
      [1, 2],
      [1, 2, 3],
    ],
    [
      [1, 2, 3, 4],
      [1, 2, 3],
    ],
    [
      [1, 1, 2],
      [1, 2],
    ],
    [[1, 1], [1]],
    [[], [1]],
  ])('rejects versions %j vs %j', (g, v) => {
    expect(() => R.assertGrantsCoverVersions(g, v)).toThrowError(
      code('key-versions-mismatch'),
    );
  });
});
