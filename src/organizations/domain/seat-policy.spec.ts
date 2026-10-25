import { ConflictError } from '../../shared/domain/errors.js';
import { SeatPolicy } from './seat-policy.js';

describe('SeatPolicy', () => {
  it('is unlimited for every plan today', () => {
    expect(SeatPolicy.seatLimit('free')).toBeNull();
    expect(SeatPolicy.seatLimit('anything')).toBeNull();
    expect(() => SeatPolicy.assertSeatAvailable(10_000, 'free')).not.toThrow();
  });

  it('throws seat-limit-reached when a limit is hit', () => {
    const spy = vi.spyOn(SeatPolicy, 'seatLimit').mockReturnValue(3);
    expect(() => SeatPolicy.assertSeatAvailable(2, 'p')).not.toThrow();
    try {
      SeatPolicy.assertSeatAvailable(3, 'p');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError);
      expect((e as ConflictError).code).toBe('seat-limit-reached');
    }
    spy.mockRestore();
  });
});
