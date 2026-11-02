import { ConflictError } from '../../shared/domain/errors.js';
import { KeyRotationRules as R } from './key-rotation.js';

const code = (c: string) => expect.objectContaining({ code: c });

const thrown = (f: () => void): ConflictError => {
  try {
    f();
  } catch (e) {
    return e as ConflictError;
  }
  throw new Error('did not throw');
};

describe('KeyRotationRules', () => {
  it('the 409 tells the expected, missing, unexpected and duplicated ids (hubs and members) and versions', () => {
    expect(
      thrown(() => R.assertHubGrantsMatchRoom(['h3', 'h1', 'h1'], ['h2', 'h1']))
        .details,
    ).toEqual({
      expectedHubIds: ['h1', 'h2'],
      missingHubIds: ['h2'],
      unexpectedHubIds: ['h3'],
      duplicatedHubIds: ['h1'],
    });
    expect(
      thrown(() => R.assertHubGrantsMatchRoom([], ['h1'])).details,
    ).toEqual({
      expectedHubIds: ['h1'],
      missingHubIds: ['h1'],
      unexpectedHubIds: [],
      duplicatedHubIds: [],
    });
    expect(
      thrown(() => R.assertGrantsMatchMembers(['b', 'c'], ['a', 'b'])).details,
    ).toEqual({
      expectedUserIds: ['a', 'b'],
      missingUserIds: ['a'],
      unexpectedUserIds: ['c'],
      duplicatedUserIds: [],
    });
    expect(
      thrown(() => R.assertGrantsCoverVersions([2, 10, 2], [1, 2, 10])).details,
    ).toEqual({
      expectedVersions: [1, 2, 10],
      missingVersions: [1],
      unexpectedVersions: [],
      duplicatedVersions: [2],
    });
  });

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

  it('hub copies must cover exactly the active room hubs (same 409 key-rotation-mismatch)', () => {
    expect(() => R.assertHubGrantsMatchRoom([], [])).not.toThrow();
    expect(() =>
      R.assertHubGrantsMatchRoom(['h2', 'h1'], ['h1', 'h2']),
    ).not.toThrow();
    for (const [g, room] of [
      [[], ['h1']],
      [['h1'], []],
      [['h1', 'h1'], ['h1']],
      [
        ['h1', 'h3'],
        ['h1', 'h2'],
      ],
    ] as const) {
      expect(() => R.assertHubGrantsMatchRoom(g, room)).toThrowError(
        code('key-rotation-mismatch'),
      );
    }
  });
});
