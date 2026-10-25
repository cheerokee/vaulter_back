import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { REAUTH_THROTTLER } from './rate-limits.js';

const DEFAULT_LIMIT_METADATA = 'THROTTLER:LIMITdefault';

/**
 * ThrottlerGuard that always answers with the standard `Retry-After` (seconds), whichever named
 * throttler blocked (the library only sets suffixed names for non-default throttlers). The 429 body is
 * produced by the global ProblemDetailsFilter.
 *
 * The `default` throttler is one budget per IP in total: unless the route sets its own `@Throttle`
 * limit, its key is the tracker alone (the library default also mixes in class and handler).
 * The `reauth` throttler is one budget per user across all its routes: key = tracker alone, always.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override generateKey(
    context: ExecutionContext,
    suffix: string,
    name: string,
  ): string {
    if (name === REAUTH_THROTTLER) {
      return createHash('sha256').update(`reauth-${suffix}`).digest('hex');
    }
    if (name === 'default' && !this.hasOwnDefaultLimit(context)) {
      return createHash('sha256').update(`global-${suffix}`).digest('hex');
    }
    return super.generateKey(context, suffix, name);
  }

  private hasOwnDefaultLimit(context: ExecutionContext): boolean {
    // Metadata written by @Throttle({ default: ... }); the library does not export the constant.
    return (
      this.reflector.getAllAndOverride(DEFAULT_LIMIT_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) !== undefined
    );
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const { res } = this.getRequestResponse(context);
    this.setResponseHeader(
      res,
      'Retry-After',
      Math.max(1, detail.timeToBlockExpire),
    );
    await super.throwThrottlingException(context, detail);
  }
}
