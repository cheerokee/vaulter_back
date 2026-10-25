import { DomainValidationError } from '../../shared/domain/errors.js';
import { DEFAULT_KDF_PARAMS, parseKdfParams } from './kdf-params.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainValidationError);
    return (e as DomainValidationError).code;
  }
  return undefined;
}

describe('parseKdfParams', () => {
  it('accepts the default', () => {
    expect(parseKdfParams({ ...DEFAULT_KDF_PARAMS })).toEqual(
      DEFAULT_KDF_PARAMS,
    );
    expect(DEFAULT_KDF_PARAMS).toEqual({
      algorithm: 'argon2id13',
      opsLimit: 3,
      memLimitBytes: 67108864,
    });
  });

  it('accepts range boundaries', () => {
    expect(
      parseKdfParams({
        algorithm: 'argon2id13',
        opsLimit: 2,
        memLimitBytes: 67108864,
      }),
    ).toBeTruthy();
    expect(
      parseKdfParams({
        algorithm: 'argon2id13',
        opsLimit: 10,
        memLimitBytes: 1073741824,
      }),
    ).toBeTruthy();
  });

  it.each([
    [
      'opsLimit 1',
      { ...DEFAULT_KDF_PARAMS, opsLimit: 1 },
      'kdf-params-out-of-range',
    ],
    [
      'opsLimit 11',
      { ...DEFAULT_KDF_PARAMS, opsLimit: 11 },
      'kdf-params-out-of-range',
    ],
    [
      'mem 1024',
      { ...DEFAULT_KDF_PARAMS, memLimitBytes: 1024 },
      'kdf-params-out-of-range',
    ],
    [
      'mem too big',
      { ...DEFAULT_KDF_PARAMS, memLimitBytes: 1073741825 },
      'kdf-params-out-of-range',
    ],
    ['extra key', { ...DEFAULT_KDF_PARAMS, extra: 1 }, 'kdf-params-invalid'],
    [
      'missing key',
      { algorithm: 'argon2id13', opsLimit: 3 },
      'kdf-params-invalid',
    ],
    [
      'algorithm',
      { ...DEFAULT_KDF_PARAMS, algorithm: 'argon2i13' },
      'kdf-params-invalid',
    ],
    [
      'opsLimit 2.5',
      { ...DEFAULT_KDF_PARAMS, opsLimit: 2.5 },
      'kdf-params-invalid',
    ],
    [
      'opsLimit string',
      { ...DEFAULT_KDF_PARAMS, opsLimit: '3' },
      'kdf-params-invalid',
    ],
    ['null', null, 'kdf-params-invalid'],
    ['array', [], 'kdf-params-invalid'],
    ['string', 'x', 'kdf-params-invalid'],
  ])('rejects %s', (_n, input, code) => {
    expect(codeOf(() => parseKdfParams(input))).toBe(code);
  });
});
