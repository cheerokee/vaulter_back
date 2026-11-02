import { Reflector } from '@nestjs/core';
import type {
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { ipTracker } from './ip-tracker.js';

// The `default` throttler (and every route limit without its own tracker) uses the library's getTracker. Pin that it
// already groups IPv6 by /64, like `ipTracker` (used by the per-user/per-hub trackers as their IP fallback).
describe('AppThrottlerGuard default tracker', () => {
  const guard = new AppThrottlerGuard(
    { throttlers: [] } as ThrottlerModuleOptions,
    {} as ThrottlerStorage,
    new Reflector(),
  );
  const track = (ip: string) =>
    (
      guard as unknown as { getTracker(req: object): Promise<string> }
    ).getTracker({ ip });

  it('collapses IPv6 to its /64 and keeps IPv4 as is, the same as ipTracker', async () => {
    const a = await track('2001:db8:1:2::a');
    expect(await track('2001:db8:1:2:ffff:ffff:ffff:1')).toBe(a);
    expect(await track('2001:db8:1:3::a')).not.toBe(a);
    expect(a).toBe(ipTracker('2001:db8:1:2::a'));
    expect(await track('198.51.100.7')).toBe('198.51.100.7');
  });
});
