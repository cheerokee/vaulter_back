import type { LinkCode } from './link-code.js';

export abstract class LinkCodeRepository {
  abstract create(code: LinkCode): Promise<void>;
  /**
   * Conditional (`used_at IS NULL AND expires_at > now`), single use: returns the code only to the winner,
   * `null` for unknown, used or expired (the same outcome).
   */
  abstract consume(codeHash: string, now: Date): Promise<LinkCode | null>;
}
