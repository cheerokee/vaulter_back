import {
  THROTTLE_GROUP_KEY,
  ThrottleByEmail,
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
      @ThrottleGroup('g1', { limit: 3, ttl: 1000 })
      a(): void {}
    }
    const handler = Object.getOwnPropertyDescriptor(Probe.prototype, 'a')!
      .value as () => void;
    expect(Reflect.getMetadata(THROTTLE_GROUP_KEY, handler)).toBe('g1');
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(3);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(1000);
  });
});
