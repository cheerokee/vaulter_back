import { ThrottleByEmail } from './throttling.decorators.js';

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
