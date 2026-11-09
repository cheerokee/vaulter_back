/**
 * A `bigint` byte count as the pg driver returns it (a string) -> a JS number. Exact up to 2^53 (8 PiB), far beyond
 * any size the API accepts; anything else is corrupt data and fails loudly instead of losing precision.
 */
export function byteCount(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`Invalid byte count from the database: ${String(value)}`);
  }
  return n;
}
