import type { DataSource } from 'typeorm';

/**
 * The tables whose versions are assigned at commit, in commit order: the conversation feeds (migration
 * ConversationFeedCommitOrder) and the hub sync (migration HubSyncCommitOrder), one sequence and one advisory lock. A
 * committed row is never `sync_pending`. One left pending means the commit-time UPDATE changed 0 rows (e.g. a policy
 * without the `sync_commit_in_progress()` escape, or a missing column grant) and the row is silently out of the feeds
 * forever.
 */
export const CONVERSATION_FEED_TABLES = [
  'conversations',
  'conversation_participants',
  'conversation_key_grants',
  'conversation_messages',
  'conversation_attachments',
] as const;

/** The tables `GET /hub/sync` reads (HubSyncSqlReader), with the key the commit-time UPDATE matches on. */
export const HUB_SYNC_TABLES = {
  hubs: ['id'],
  organizations: ['id'],
  users: ['id'],
  role_assignments: ['id'],
  spaces: ['id'],
  space_keys: ['id'],
  space_key_grants: ['id'],
  hub_organization: ['organization_id', 'hub_id'],
  hub_space: ['space_id', 'hub_id'],
  user_organization: ['organization_id', 'user_id'],
} as const satisfies Record<string, readonly string[]>;

export const COMMIT_ORDERED_TABLES = [
  ...CONVERSATION_FEED_TABLES,
  ...(Object.keys(HUB_SYNC_TABLES) as (keyof typeof HUB_SYNC_TABLES)[]),
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
