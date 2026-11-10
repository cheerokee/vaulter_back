export type ChangeWait = 'changed' | 'timeout' | 'closed';

/** A Hub's interest in "something changed in a conversation where you are (or were) executor". */
export interface ConversationChangeSubscription {
  /**
   * false = no live wake source (degraded: the caller re-reads on a short interval instead of trusting a wake). A wake
   * is only a hint: the caller ALWAYS re-reads by `sync_version`, so a missed wake only delays a change, never loses it.
   */
  readonly live: boolean;
  /**
   * `changed` on a wake (also one that arrived after `subscribe` and before this call), `timeout` on timeout or abort,
   * `closed` when the process is shutting down (the caller answers what it has). Holds no database connection.
   */
  next(timeoutMs: number, abort?: AbortSignal): Promise<ChangeWait>;
  close(): void;
}

/**
 * Wake source of the executor's long poll. Subscribe BEFORE reading, so a change committed after the read's snapshot
 * always wakes the wait.
 */
export abstract class ConversationChangeSignal {
  abstract subscribe(hubId: string): Promise<ConversationChangeSubscription>;
}
