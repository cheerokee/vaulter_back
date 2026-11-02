import { USER_THROTTLER } from './rate-limits.js';
import {
  THROTTLE_BY_USER_KEY,
  THROTTLE_GROUP_KEY,
  ThrottleByEmail,
  ThrottleByUser,
  ThrottleGroup,
  ThrottleReauth,
} from './throttling.decorators.js';

describe('ThrottleByEmail', () => {
  it('is a method decorator only (the skipIf reads handler metadata)', () => {
    expectTypeOf(ThrottleByEmail(() => 'x')).toEqualTypeOf<MethodDecorator>();
  });

  it('cannot be applied to a class', () => {
    // @ts-expect-error class decorators are not supported
    @ThrottleByEmail(() => 'x')
    class Dummy {}
    expect(Dummy).toBeDefined();
  });
});

describe('ThrottleReauth', () => {
  it('is a method decorator only (the skipIf reads handler metadata)', () => {
    expectTypeOf(ThrottleReauth()).toEqualTypeOf<MethodDecorator>();
  });
});

describe('ThrottleGroup', () => {
  it('marks the handler with its group and sets its own default limit', () => {
    class Probe {
      @ThrottleGroup({ name: 'g1', limit: 3, ttl: 1000 })
      a(): void {}
    }
    const handler = Object.getOwnPropertyDescriptor(Probe.prototype, 'a')!
      .value as () => void;
    expect(Reflect.getMetadata(THROTTLE_GROUP_KEY, handler)).toBe('g1');
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(3);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(1000);
  });

  it('accepts the same group again with the same limit, and refuses another limit', () => {
    const g = { name: 'g2', limit: 5, ttl: 60_000 };
    expect(() => ThrottleGroup(g)).not.toThrow();
    expect(() => ThrottleGroup({ ...g })).not.toThrow();
    expect(() => ThrottleGroup({ ...g, limit: 6 })).toThrow(/two limits/);
    expect(() => ThrottleGroup({ ...g, ttl: 1 })).toThrow(/two limits/);
  });
});

describe('ThrottleByUser', () => {
  it('marks the handler and sets the `user` throttler limit, leaving `default` to the route', () => {
    class Probe {
      @ThrottleByUser({ limit: 4, ttl: 2000 })
      a(): void {}
    }
    const handler = Object.getOwnPropertyDescriptor(Probe.prototype, 'a')!
      .value as () => void;
    expect(Reflect.getMetadata(THROTTLE_BY_USER_KEY, handler)).toBe(true);
    expect(
      Reflect.getMetadata(`THROTTLER:LIMIT${USER_THROTTLER}`, handler),
    ).toBe(4);
    expect(Reflect.getMetadata(`THROTTLER:TTL${USER_THROTTLER}`, handler)).toBe(
      2000,
    );
    expect(
      Reflect.getMetadata('THROTTLER:LIMITdefault', handler),
    ).toBeUndefined();
  });
});
