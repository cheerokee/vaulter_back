import type { Enrollment } from './enrollment.js';

export abstract class EnrollmentRepository {
  /**
   * Throws ConflictError('nonce-reused') when the (signing key, nonce) pair was already presented, and
   * ConflictError('claim-code-collision') when another PENDING enrollment holds the same code hash (the caller
   * draws a new code and retries), and ConflictError('enrollment-pending-for-key') when another PENDING enrollment
   * has the same signing key (a concurrent enrollment won the race: the caller expires it and retries).
   */
  abstract create(enrollment: Enrollment): Promise<void>;
  /**
   * Flags every PENDING enrollment of the signing key as expired (one pending per key: the newest presentation
   * wins). Conditional on `status = 'pending'`: an enrollment being claimed is left alone. Returns how many.
   */
  abstract expirePendingOfKey(signingPublicKey: string): Promise<number>;
  abstract findById(enrollmentId: string): Promise<Enrollment | null>;
  abstract findPendingByCodeHash(codeHash: string): Promise<Enrollment | null>;
  /**
   * `findPendingByCodeHash` with SELECT ... FOR UPDATE. REQUIRES an active unit of work. A concurrent claim of the
   * same code waits here and, once the winner commits, re-checks the row and gets null.
   */
  abstract lockPendingByCodeHash(codeHash: string): Promise<Enrollment | null>;
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
