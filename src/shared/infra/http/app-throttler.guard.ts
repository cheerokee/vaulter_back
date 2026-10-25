import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';

/**
 * ThrottlerGuard that always answers with the standard `Retry-After` (seconds), whichever named
 * throttler blocked (the library only sets suffixed names for non-default throttlers). The 429 body is
 * produced by the global ProblemDetailsFilter.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
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
