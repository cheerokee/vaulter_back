import { DomainValidationError } from '../../shared/domain/errors.js';

export type KdfParams = {
  algorithm: 'argon2id13';
  opsLimit: number;
  memLimitBytes: number;
};

export const DEFAULT_KDF_PARAMS: KdfParams = {
  algorithm: 'argon2id13',
  opsLimit: 3,
  memLimitBytes: 67108864,
};

const OPS_MIN = 2;
const OPS_MAX = 10;
const MEM_MIN = 67108864;
const MEM_MAX = 1073741824;
const KEYS = ['algorithm', 'memLimitBytes', 'opsLimit'];

function invalid(): never {
  throw new DomainValidationError(
    'kdf-params-invalid',
    'The key derivation parameters are invalid.',
  );
}

export function parseKdfParams(raw: unknown): KdfParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalid();
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i]))
    invalid();
  const { algorithm, opsLimit, memLimitBytes } = obj;
  if (
    algorithm !== 'argon2id13' ||
    typeof opsLimit !== 'number' ||
    typeof memLimitBytes !== 'number' ||
    !Number.isInteger(opsLimit) ||
    !Number.isInteger(memLimitBytes)
  ) {
    invalid();
  }
  if (
    opsLimit < OPS_MIN ||
    opsLimit > OPS_MAX ||
    memLimitBytes < MEM_MIN ||
    memLimitBytes > MEM_MAX
  ) {
    throw new DomainValidationError(
      'kdf-params-out-of-range',
      'The key derivation parameters are out of the accepted range.',
    );
  }
  return { algorithm: 'argon2id13', opsLimit, memLimitBytes };
}
