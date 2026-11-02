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
export const THROTTLE_GROUP_KEY = 'throttleGroup';

/**
 * A shared counter: its name and its ONE limit. Define each group once, as a constant (see `THROTTLE_GROUPS` in
 * rate-limits.ts), and mark every route of the group with that same constant.
 */
export type ThrottleGroupSpec = {
  readonly name: string;
  readonly limit: number;
  readonly ttl: number;
};

// Limit of each group seen so far: two routes of one group with different limits would make the shared counter
// depend on which route was hit last, so it fails at class definition time (i.e. at startup and in any test).
const groupLimits = new Map<string, string>();

/**
 * Own `default` limit shared by every route marked with the same group: the guard keys the counter by the group
 * and the tracker, without the route (e.g. the hub challenge and token routes: one budget per IP for both).
 * `getTracker` omitted = the default tracker. Throws if the group was already used with another limit or ttl.
 */
export const ThrottleGroup = (
  group: ThrottleGroupSpec,
  getTracker?: ThrottlerGetTrackerFunction,
): MethodDecorator => {
  const limits = `${group.limit}/${group.ttl}`;
  const seen = groupLimits.get(group.name);
  if (seen !== undefined && seen !== limits) {
    throw new Error(
      `ThrottleGroup "${group.name}" used with two limits (${seen} and ${limits}); use one THROTTLE_GROUPS constant`,
    );
  }
  groupLimits.set(group.name, limits);
  return applyDecorators(
    SetMetadata(THROTTLE_GROUP_KEY, group.name),
    Throttle({
      default: {
        limit: group.limit,
        ttl: group.ttl,
        ...(getTracker ? { getTracker } : {}),
      },
    }),
  );
};

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
