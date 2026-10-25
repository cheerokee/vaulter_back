import { assertWrappedSpaceKey } from '../../domain/wrapped-key.js';

/** A wrapped copy of one key version for one recipient (the version tells which key). */
export type VersionGrantInput = { version: number; wrappedKey: string };

/** Format check of every wrapped key (422 `wrapped-key-invalid`); the key never goes into the message. */
export function assertWrappedKeys(keys: readonly string[]): void {
  for (const key of keys) assertWrappedSpaceKey(key);
}
