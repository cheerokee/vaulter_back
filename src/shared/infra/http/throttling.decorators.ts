import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { ThrottlerGetTrackerFunction } from '@nestjs/throttler';
import { EMAIL_THROTTLER, RATE_LIMITS } from './rate-limits.js';

export const THROTTLE_BY_EMAIL_KEY = 'throttleByEmail';

/**
 * Adds the per-e-mail counter to a route (the `email` throttler is skipped everywhere else).
 * The tracker comes from the caller because only the owning module knows how to read and normalize
 * the e-mail from its request body.
 */
export const ThrottleByEmail = (
  getTracker: ThrottlerGetTrackerFunction,
): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(THROTTLE_BY_EMAIL_KEY, true),
    Throttle({ [EMAIL_THROTTLER]: { ...RATE_LIMITS.loginEmail, getTracker } }),
  );
