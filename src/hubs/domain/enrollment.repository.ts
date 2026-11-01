import type { Enrollment } from './enrollment.js';

export abstract class EnrollmentRepository {
  abstract create(enrollment: Enrollment): Promise<void>;
  abstract findById(enrollmentId: string): Promise<Enrollment | null>;
  abstract findPendingByCodeHash(codeHash: string): Promise<Enrollment | null>;
  /**
   * Conditional (`WHERE status = 'pending' AND expires_at > now`): true only for the caller that won; a concurrent
   * claim, or one past `expiresAt`, gets false. Callers still run `enrollment.assertClaimable(now)` first.
   */
  abstract markClaimed(
    enrollmentId: string,
    hubId: string,
    now: Date,
  ): Promise<boolean>;
  /** Flags pending enrollments past `expiresAt` as expired; returns how many. */
  abstract expireStale(now: Date): Promise<number>;
}
