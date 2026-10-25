import { EventEmitter } from 'node:events';

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
  'setCookie',
  'set-cookie',
  'password',
  'refreshTokenHash',
  'secret',
  'token',
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

// Objetos que nunca percorremos: streams, sockets, IncomingMessage/ServerResponse (EventEmitter),
// binários e promises.
function isOpaque(value: object): boolean {
  return (
    value instanceof EventEmitter ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Promise
  );
}

function scrubEntries(
  value: object,
  out: Record<string, unknown>,
  seen: WeakMap<object, unknown>,
): void {
  for (const [k, v] of Object.entries(value)) {
    out[k] = LOWER.has(k.toLowerCase()) ? REDACTED : scrub(v, seen);
  }
}

// Arrays, Map, Set e qualquer objeto (inclusive instâncias de classe, como DTOs) são percorridos pelas
// próprias propriedades enumeráveis. Error vira objeto simples preservando name/message/stack
// (não enumeráveis). Opacos (ver isOpaque) passam por referência.
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
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    seen.set(value, out);
    if ('cause' in value) out.cause = scrub(value.cause, seen);
    scrubEntries(value, out, seen);
    return out;
  }
  if (isOpaque(value)) return value;
  if (value instanceof Set) {
    const arr: unknown[] = [];
    seen.set(value, arr);
    for (const item of value) arr.push(scrub(item, seen));
    return arr;
  }
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [k, v] of value) {
      const key = String(k);
      out[key] = LOWER.has(key.toLowerCase()) ? REDACTED : scrub(v, seen);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  scrubEntries(value, out, seen);
  return out;
}
