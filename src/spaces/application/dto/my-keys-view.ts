/** The caller's wrapped copies of every key version (only the caller can open them). */
export type MyKeysView = {
  currentVersion: number;
  keys: { version: number; wrappedKey: string }[];
};
