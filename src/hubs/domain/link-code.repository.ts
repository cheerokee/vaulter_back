import type { LinkCode } from './link-code.js';

export abstract class LinkCodeRepository {
  abstract create(code: LinkCode): Promise<void>;
  /**
   * Conditional (`used_at IS NULL AND expires_at > now`), single use: returns the code only to the winner,
   * `null` for unknown, used or expired (the same outcome).
   */
  abstract consume(codeHash: string, now: Date): Promise<LinkCode | null>;
  /**
   * Tombstones unused codes past `expiresAt`, which frees their hash for new codes (the hash is unique among live
   * codes only); returns how many. Call it before issuing a code; a rare collision with a live code is a 23505.
   */
  abstract expireStale(now: Date): Promise<number>;
}
