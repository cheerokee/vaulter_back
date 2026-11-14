import { ConversationFeedSequenceFloor1792897400000 } from '../../src/database/migrations/1792897400000-ConversationFeedSequenceFloor.js';
import type { INestApplication } from '@nestjs/common';
import {
  COMMIT_ORDERED_SYNC_FEED,
  ORIGINAL_POLICY_PREFIX,
} from '../../src/shared/infra/db/migration-helpers.js';
import {
  COMMIT_ORDERED_TABLES,
  CONVERSATION_FEED_TABLES,
  HUB_SYNC_TABLES,
} from '../setup/commit-order-check.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { hubsKit } from '../support/hubs-kit.js';
import { identityClient } from '../support/identity-client.js';

// Schema invariants of the commit-ordered versions (migrations ConversationFeedCommitOrder and HubSyncCommitOrder,
// `addCommitOrderedSyncVersion`), over the fifteen tables of both feeds (one sequence, one advisory lock).
// A policy without the `sync_commit_in_progress()` escape makes the commit-time UPDATE change 0 rows: the row stays
// `sync_pending` and is silently out of the feeds forever. A trigger that locks after the advisory lock breaks "the
// advisory lock is the last lock". These fail loudly when a later migration forgets either (the e2e reset and teardown
// also check that no committed row is left pending: `test/setup/commit-order-check.ts`).
describe('commit-ordered sync versions: schema invariants (e2e)', () => {
  const ESCAPE = 'sync_commit_in_progress()';

  it('every RLS table of the feed has the permissive escape policies; every RESTRICTIVE SELECT/UPDATE/ALL policy carries the escape', async () => {
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
    const rls = new Set(
      (
        (await ds.query(
          `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity`,
          [[...COMMIT_ORDERED_TABLES]],
        )) as { relname: string }[]
      ).map((r) => r.relname),
    );
    // `users` has no RLS: no escape policy (it would be dead code).
    expect(rls.has('users')).toBe(false);
    expect(
      policies.filter(
        (p) =>
          p.tablename === 'users' && p.policyname.startsWith('sync_commit'),
      ),
    ).toEqual([]);
    for (const table of COMMIT_ORDERED_TABLES.filter((t) => rls.has(t))) {
      const own = policies.filter(
        (p) => p.tablename === table && p.permissive === 'PERMISSIVE',
      );
      expect(
        own.find((p) => p.policyname === 'sync_commit_read'),
      ).toMatchObject({ cmd: 'SELECT', qual: ESCAPE });
      expect(
        own.find((p) => p.policyname === 'sync_commit_update'),
      ).toMatchObject({ cmd: 'UPDATE', qual: ESCAPE, with_check: ESCAPE });
    }
    // Some restrictive SELECT and UPDATE policy exists (the filter above is not vacuous).
    for (const table of CONVERSATION_FEED_TABLES) {
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
      expect(commit!.def).toContain(COMMIT_ORDERED_SYNC_FEED.lockKey);
      expect(commit!.def).toContain(COMMIT_ORDERED_SYNC_FEED.sequence);
      const keys: readonly string[] = HUB_SYNC_TABLES[
        table as keyof typeof HUB_SYNC_TABLES
      ] ?? ['id'];
      if (keys.join() !== 'id') {
        expect(commit!.def).toContain(keys.map((k) => `'${k}'`).join(', '));
      }
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
      for (const table of CONVERSATION_FEED_TABLES) {
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

      for (const table of CONVERSATION_FEED_TABLES) {
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
        [[...CONVERSATION_FEED_TABLES]],
      )) as { key: string; description: string }[];
      expect(new Map(healed.map((h) => [h.key, h.description]))).toEqual(
        comments,
      );
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });

  it('hubs: the runtime may update sync_version and sync_pending (commit-time UPDATE under the column grants)', async () => {
    const ds = await adminDataSource();
    const rows = (await ds.query(
      `SELECT c AS column, has_column_privilege('app_runtime', 'hubs', c, 'UPDATE') AS ok
         FROM unnest(ARRAY['sync_version', 'sync_pending']) AS c`,
    )) as { column: string; ok: boolean }[];
    expect(rows).toEqual([
      { column: 'sync_version', ok: true },
      { column: 'sync_pending', ok: true },
    ]);
  });

  describe('with an application', () => {
    let app: INestApplication;
    const c = identityClient(() => app);
    const k = hubsKit(() => app);

    beforeAll(async () => {
      app = await createTestApp();
      await resetDatabase();
    });
    afterAll(async () => {
      await app.close();
    });

    it('a composite-key row written twice in one transaction gets one version, from the shared sequence, and is not left pending', async () => {
      const olivia = await c.spaces.signUpKeyed(
        'co-olivia@example.com',
        'Olivia',
        'correct horse battery staple',
      );
      const hub = await k.claim(olivia, 'Sala');
      const ds = await adminDataSource();
      const [{ before }] = (await ds.query(
        `SELECT last_value::text AS before FROM ${COMMIT_ORDERED_SYNC_FEED.sequence}`,
      )) as [{ before: string }];
      const qr = ds.createQueryRunner();
      await qr.connect();
      try {
        await qr.startTransaction();
        await qr.query(
          `UPDATE hub_organization SET updated_at = now() WHERE hub_id = $1`,
          [hub.hubId],
        );
        await qr.query(
          `UPDATE hub_organization SET deleted_at = now() WHERE hub_id = $1`,
          [hub.hubId],
        );
        await qr.commitTransaction();
      } finally {
        await qr.release();
      }
      const rows = (await ds.query(
        `SELECT sync_version::text AS v, sync_pending FROM hub_organization WHERE hub_id = $1`,
        [hub.hubId],
      )) as { v: string; sync_pending: boolean }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sync_pending).toBe(false);
      expect(BigInt(rows[0]!.v)).toBe(BigInt(before) + 1n);
    });
  });
});
