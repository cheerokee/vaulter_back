import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { ThrottlerGetTrackerFunction } from '@nestjs/throttler';
import {
  EMAIL_THROTTLER,
  RATE_LIMITS,
  REAUTH_THROTTLER,
} from './rate-limits.js';
import { userIdTracker } from './user-id.tracker.js';

export const THROTTLE_BY_EMAIL_KEY = 'throttleByEmail';
export const THROTTLE_REAUTH_KEY = 'throttleReauth';

/**
 * Adds the per-e-mail counter to a route (the `email` throttler is skipped everywhere else).
 * The tracker comes from the caller because only the owning module knows how to read and normalize
 * the e-mail from its request body.
 *
 * Methods only (typed as MethodDecorator): the `skipIf` of the `email` throttler reads handler metadata,
 * so a class-level mark would silently do nothing.
 */
export const ThrottleByEmail = (
  getTracker: ThrottlerGetTrackerFunction,
): MethodDecorator =>
  applyDecorators(
    SetMetadata(THROTTLE_BY_EMAIL_KEY, true),
    Throttle({ [EMAIL_THROTTLER]: { ...RATE_LIMITS.loginEmail, getTracker } }),
  );

/**
 * Charges the shared per-user reauthentication budget (`RATE_LIMITS.reauth`): every route that verifies the
 * current password proof uses it, and they all share ONE counter per user (the guard keys the `reauth`
 * throttler by the user alone, without the route), so an attacker with a stolen access token cannot get
 * 5 guesses per route. Needs `request.auth` (the access token guard runs before the throttler).
 *
 * Methods only, like ThrottleByEmail (the `skipIf` reads handler metadata).
 */
export const ThrottleReauth = (): MethodDecorator =>
  applyDecorators(
    SetMetadata(THROTTLE_REAUTH_KEY, true),
    Throttle({
      [REAUTH_THROTTLER]: { ...RATE_LIMITS.reauth, getTracker: userIdTracker },
    }),
  );
