import type { DataSource } from 'typeorm';

/**
 * The conversation feed tables whose versions are assigned at commit (migration ConversationFeedCommitOrder): a
 * committed row is never `sync_pending`. One left pending means the commit-time UPDATE changed 0 rows (e.g. a policy
 * without the `sync_commit_in_progress()` escape) and the row is silently out of the feeds forever.
 */
export const COMMIT_ORDERED_TABLES = [
  'conversations',
  'conversation_participants',
  'conversation_key_grants',
  'conversation_messages',
  'conversation_attachments',
] as const;

/** Fails loudly when a committed row of a commit-ordered table is still `sync_pending` (run by every reset and at teardown). */
export async function assertNoPendingSyncRows(
  ds: DataSource,
  when: string,
): Promise<void> {
  const present: { tablename: string }[] = await ds.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [[...COMMIT_ORDERED_TABLES]],
  );
  for (const { tablename } of present) {
    const [{ n }] = (await ds.query(
      `SELECT count(*)::int AS n FROM "${tablename}" WHERE sync_pending`,
    )) as [{ n: number }];
    if (n > 0) {
      throw new Error(
        `${when}: ${n} committed row(s) of ${tablename} still sync_pending: the commit-time version UPDATE missed them ` +
          '(a policy without sync_commit_in_progress()? see addCommitOrderedSyncVersion)',
      );
    }
  }
}
