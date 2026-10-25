import type { ConfigService } from '@nestjs/config';

/** Idle lifetime of a refresh token, in days (`AUTH_REFRESH_TOKEN_IDLE_DAYS`). */
export function refreshIdleDays(config: ConfigService): number {
  return Number(config.getOrThrow<number>('AUTH_REFRESH_TOKEN_IDLE_DAYS'));
}
