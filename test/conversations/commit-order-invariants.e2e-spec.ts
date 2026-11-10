import { ConversationFeedSequenceFloor1792897400000 } from '../../src/database/migrations/1792897400000-ConversationFeedSequenceFloor.js';
import {
  CONVERSATION_SYNC_FEED,
  ORIGINAL_POLICY_PREFIX,
} from '../../src/shared/infra/db/migration-helpers.js';
import { COMMIT_ORDERED_TABLES } from '../setup/commit-order-check.js';
import { adminDataSource } from '../setup/test-app.js';

// Schema invariants of the commit-ordered versions (migration ConversationFeedCommitOrder, `addCommitOrderedSyncVersion`).
// A policy without the `sync_commit_in_progress()` escape makes the commit-time UPDATE change 0 rows: the row stays
// `sync_pending` and is silently out of the feeds forever. A trigger that locks after the advisory lock breaks "the
// advisory lock is the last lock". These fail loudly when a later migration forgets either (the e2e reset and teardown
// also check that no committed row is left pending: `test/setup/commit-order-check.ts`).
describe('commit-ordered sync versions: schema invariants (e2e)', () => {
  const ESCAPE = 'sync_commit_in_progress()';

  it('every RESTRICTIVE SELECT/UPDATE/ALL policy of the five tables carries the escape, and the permissive escape policies exist', async () => {
    const ds = await adminDataSource();
    const policies = (await ds.query(
      `SELECT tablename, policyname, permissive, cmd, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [[...COMMIT_ORDERED_TABLES]],
    )) as {
      tablename: string;
      policyname: string;
      permissive: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }[];
    const missing = policies
      .filter(
        (p) =>
          p.permissive === 'RESTRICTIVE' &&
          ['SELECT', 'UPDATE', 'ALL'].includes(p.cmd) &&
          ((p.qual !== null && !p.qual.includes(ESCAPE)) ||
            (p.with_check !== null && !p.with_check.includes(ESCAPE))),
      )
      .map((p) => `${p.tablename}.${p.policyname}`);
    expect(missing).toEqual([]);
    for (const table of COMMIT_ORDERED_TABLES) {
      const own = policies.filter(
        (p) => p.tablename === table && p.permissive === 'PERMISSIVE',
      );
      expect(
        own.find((p) => p.policyname === 'sync_commit_read'),
      ).toMatchObject({ cmd: 'SELECT', qual: ESCAPE });
      expect(
        own.find((p) => p.policyname === 'sync_commit_update'),
      ).toMatchObject({ cmd: 'UPDATE', qual: ESCAPE, with_check: ESCAPE });
      // Some restrictive SELECT and UPDATE policy exists (the filter above is not vacuous).
      expect(
        policies.filter(
          (p) => p.tablename === table && p.permissive === 'RESTRICTIVE',
        ).length,
      ).toBeGreaterThan(0);
    }
  });

  it('triggers: the provisional BEFORE trigger fires last, the deferred commit trigger is in place, and no AFTER trigger locks or writes on the commit-time UPDATE', async () => {
    const ds = await adminDataSource();
    const triggers = (await ds.query(
      `SELECT tgrelid::regclass::text AS tablename, tgname, tgdeferrable, tginitdeferred,
              (tgtype & 2) <> 0 AS before, (tgtype & 16) <> 0 AS on_update, tgattr::text <> '' AS column_list,
              pg_get_triggerdef(oid) AS def
         FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY($1) AND (tgtype & 1) <> 0`,
      [[...COMMIT_ORDERED_TABLES]],
    )) as {
      tablename: string;
      tgname: string;
      tgdeferrable: boolean;
      tginitdeferred: boolean;
      before: boolean;
      on_update: boolean;
      column_list: boolean;
      def: string;
    }[];
    // AFTER ... UPDATE triggers allowed to fire again on the commit-time UPDATE: they neither lock nor write.
    const harmless = new Set([
      'trg_conversations_notify_executor',
      'trg_conversation_participants_notify_executor',
      'trg_conversation_key_grants_notify_executor',
      'trg_conversation_messages_notify_executor',
      'trg_conversation_attachments_notify_executor',
    ]);
    for (const table of COMMIT_ORDERED_TABLES) {
      const mine = triggers.filter((t) => t.tablename === table);
      const before = mine
        .filter((t) => t.before)
        .map((t) => t.tgname)
        .sort();
      expect(before.at(-1)).toBe(`trg_${table}_zz_sync_version`);
      const commit = mine.find((t) => t.tgname === `trg_${table}_sync_commit`);
      expect(commit).toMatchObject({
        tgdeferrable: true,
        tginitdeferred: true,
      });
      expect(commit!.def).toContain('WHEN (new.sync_pending)');
      expect(commit!.def).toContain(CONVERSATION_SYNC_FEED.lockKey);
      const unsafe = mine
        .filter(
          (t) =>
            !t.before &&
            t.on_update &&
            !t.column_list &&
            t.tgname !== `trg_${table}_sync_commit` &&
            !harmless.has(t.tgname) &&
            !t.def.includes('WHEN (new.sync_pending)'),
        )
        .map((t) => t.tgname);
      expect(unsafe).toEqual([]);
    }
  });

  it('ConversationFeedSequenceFloor heals a database migrated by the old ConversationFeedCommitOrder (old trigger name, unprefixed policy comments), idempotently', async () => {
    const qr = (await adminDataSource()).createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      // The old state, in a transaction that is rolled back at the end (DDL is transactional).
      const comments = new Map<string, string>();
      for (const table of COMMIT_ORDERED_TABLES) {
        await qr.query(
          `ALTER TRIGGER "trg_${table}_zz_sync_version" ON "${table}" RENAME TO "trg_${table}_sync_version"`,
        );
        const rows = (await qr.query(
          `SELECT pol.polname AS name, d.description
             FROM pg_policy pol JOIN pg_description d ON d.objoid = pol.oid AND d.classoid = 'pg_policy'::regclass
            WHERE pol.polrelid = $1::regclass`,
          [table],
        )) as { name: string; description: string }[];
        for (const r of rows) {
          expect(r.description.startsWith(ORIGINAL_POLICY_PREFIX)).toBe(true);
          const raw = r.description.slice(ORIGINAL_POLICY_PREFIX.length);
          comments.set(`${table}.${r.name}`, r.description);
          await qr.query(
            `COMMENT ON POLICY "${r.name}" ON "${table}" IS '${raw.replaceAll("'", "''")}'`,
          );
        }
      }
      expect(comments.size).toBeGreaterThan(0);

      const migration = new ConversationFeedSequenceFloor1792897400000();
      await migration.up(qr);
      await migration.up(qr); // idempotent

      for (const table of COMMIT_ORDERED_TABLES) {
        const names = (
          (await qr.query(
            `SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname LIKE '%sync_version'`,
            [table],
          )) as { tgname: string }[]
        ).map((t) => t.tgname);
        expect(names).toEqual([`trg_${table}_zz_sync_version`]);
      }
      const healed = (await qr.query(
        `SELECT c.relname || '.' || pol.polname AS key, d.description
           FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
           JOIN pg_description d ON d.objoid = pol.oid AND d.classoid = 'pg_policy'::regclass
          WHERE c.relname = ANY($1)`,
        [[...COMMIT_ORDERED_TABLES]],
      )) as { key: string; description: string }[];
      expect(new Map(healed.map((h) => [h.key, h.description]))).toEqual(
        comments,
      );
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });
});
