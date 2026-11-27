/** One `conversation_space_usage` counter. */
export type UsageCounter = { organizationId: string; spaceId: string };

/** What one recount found: the counter's drift (expected - stored); zero when it was right. */
export type UsageRecount = { bodyBytesDrift: number; trashBytesDrift: number };

/**
 * The database side of the usage counter reconcile. The implementation runs with the runtime login in the trusted
 * context `app.conversation_usage_reconcile` (migration MaintenanceTrustedContexts): 'scan' reads only the counters;
 * the id of ONE space reads that space's conversations and messages (read only) and reads/writes its counter.
 */
export abstract class ConversationUsageReconcileStore {
  /** Every counter (any organization), ordered by space id. */
  abstract counters(): Promise<UsageCounter[]>;
  /**
   * ONE transaction: the counter row `FOR UPDATE` first (every trigger that changes it waits; a writer that already
   * changed it is committed before the lock is granted), then the sums the triggers keep (bodies kept + headers; bodies
   * kept with a tombstone) read in the next statement, and the counter set to them when it drifted.
   */
  abstract recount(counter: UsageCounter): Promise<UsageRecount>;
}
