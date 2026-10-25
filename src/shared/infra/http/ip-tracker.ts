import { normalizeIp } from '@nestjs/throttler';

/** Same IP normalization as the library default tracker (IPv6 collapsed to its /64). */
export function ipTracker(ip: unknown): string {
  return typeof ip === 'string' ? normalizeIp(ip) : 'unknown';
}
