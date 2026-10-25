import { ConflictError } from '../../shared/domain/errors.js';

export const SeatPolicy = {
  /** Seats allowed by the plan; null = unlimited (every plan, for now). */
  seatLimit(plan: string): number | null {
    void plan;
    return null;
  },

  /** A seat is an active member; pending invitations do not count. */
  assertSeatAvailable(activeCount: number, plan: string): void {
    const limit = SeatPolicy.seatLimit(plan);
    if (limit !== null && activeCount >= limit) {
      throw new ConflictError(
        'seat-limit-reached',
        'The organization reached its seat limit.',
      );
    }
  },
};
