import { Module } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { PostgresThrottlerStorage } from './postgres-throttler.storage.js';
import { EMAIL_THROTTLER, RATE_LIMITS } from './rate-limits.js';
import { THROTTLE_BY_EMAIL_KEY } from './throttling.decorators.js';

/** RATE_LIMIT_ENABLED arrives as boolean (validated env) or as the raw string (test overrides). */
function isEnabled(value: unknown): boolean {
  return value !== false && value !== 'false';
}

/**
 * Global rate limiting. Register it AFTER the module that owns the access token guard in AppModule:
 * global guards run in module order, and the per-user counter of /me/password needs `request.auth`.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, DataSource],
      useFactory: (config: ConfigService, dataSource: DataSource) => {
        // Read per request (cheap), so the switch is not frozen at module compile time.
        const enabled = () => isEnabled(config.get('RATE_LIMIT_ENABLED'));
        return {
          storage: new PostgresThrottlerStorage(dataSource),
          errorMessage: 'Too many requests. Try again later.',
          // The default tracker is req.ip (respects TRUST_PROXY).
          throttlers: [
            {
              name: 'default',
              ...RATE_LIMITS.default,
              skipIf: () => !enabled(),
            },
            {
              name: EMAIL_THROTTLER,
              ...RATE_LIMITS.loginEmail,
              // Do not expose the per-e-mail counters (X-RateLimit-*-email); Retry-After is set by the guard.
              setHeaders: false,
              skipIf: (context: ExecutionContext) =>
                !enabled() ||
                !Reflect.getMetadata(
                  THROTTLE_BY_EMAIL_KEY,
                  context.getHandler(),
                ),
            },
          ],
        };
      },
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class ThrottlingModule {}
