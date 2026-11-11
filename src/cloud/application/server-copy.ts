import { ServerKeyring } from './ports/server-keyring.js';

/**
 * Proves a key copy was sealed to OUR server key (it opens), then wipes the opened key: the format alone cannot tell
 * a copy sealed to another key. Same 422 `server-copy-invalid` for a malformed copy and one that does not open (the
 * ServerKeyring's error). The opened key never leaves this function, never goes to a log or an error.
 */
export async function assertOpensWithServerKey(
  keyring: ServerKeyring,
  copy: string,
): Promise<void> {
  const key = await keyring.openSealed(copy);
  key.fill(0);
}
