// Chaves que nunca podem ir para log nem para o Sentry (camelCase e snake_case).
const BASE_KEYS = [
  'authProof',
  'authProofNew',
  'authProofCurrent',
  'currentAuthProof',
  'newAuthProof',
  'authHash',
  'encryptedPrivateKey',
  'newEncryptedPrivateKey',
  'kdfSalt',
  'kdfParams',
  'newKdfSalt',
  'newKdfParams',
  'wrappedKey',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'password',
] as const;

const toSnake = (k: string) =>
  k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export const SENSITIVE_KEYS: readonly string[] = [
  ...new Set(BASE_KEYS.flatMap((k) => [k, toSnake(k)])),
];

const LOWER = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

export const REDACTED = '[REDACTED]';

export function scrubSensitive<T>(value: T): T {
  return scrub(value, new WeakMap()) as T;
}

function scrub(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    seen.set(value, arr);
    for (const item of value) arr.push(scrub(item, seen));
    return arr;
  }
  if (value instanceof Date) return new Date(value.getTime());
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) {
    out[k] = LOWER.has(k.toLowerCase()) ? REDACTED : scrub(v, seen);
  }
  return out;
}
