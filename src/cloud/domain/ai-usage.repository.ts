import type {
  AiBudgetMonth,
  AiReservation,
  AiSpend,
  AiUsageKind,
} from './ai-usage.js';

/** One line of the month's usage view: what a space spent on one kind. */
export type AiUsageLine = {
  spaceId: string;
  kind: AiUsageKind;
  costMicroUsd: bigint;
  inputTokens: number;
  outputTokens: number;
  calls: number;
};

/**
 * The AI usage ledger of the active cloud (`cloud_ai_reservations` + `cloud_ai_usage`): ids, kinds, models, token
 * counts and costs only, never content. Every method sets the RLS context of `orgId`. The month is the UTC calendar
 * month by the database clock (`now()` of the transaction).
 */
export abstract class AiUsageLedger {
  /** Spent and live reservations of the current month, in ONE statement (one snapshot). */
  abstract currentMonth(orgId: string): Promise<AiBudgetMonth>;
  /** Marks the organization's reservations whose time ran out as `expired` (they stop counting); returns how many. */
  abstract expireStale(orgId: string): Promise<number>;
  /** A new live reservation counting in `reservation.month` for `ttlSeconds` from now. */
  abstract insertReservation(
    reservation: AiReservation,
    ttlSeconds: number,
  ): Promise<void>;
  /**
   * Records the real spend of a live or expired reservation and adds it to the month's usage line of its space and
   * kind (in the reservation's month). False when it was already settled or released (nothing written). Two
   * statements: REQUIRES a unit of work.
   */
  abstract settle(
    orgId: string,
    reservationId: string,
    spend: AiSpend,
  ): Promise<boolean>;
  /** Moves a LIVE reservation's expiry to `ttlSeconds` from now; false when it is no longer live. */
  abstract extend(
    orgId: string,
    reservationId: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  /** Gives a live or expired reservation back without spend; false when it was already settled or released. */
  abstract release(orgId: string, reservationId: string): Promise<boolean>;
  /** The current month's usage lines, by space and kind (space id order). */
  abstract currentMonthLines(orgId: string): Promise<AiUsageLine[]>;
}
