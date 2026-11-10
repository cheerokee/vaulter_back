import type { QueryRunner } from 'typeorm';

// Adiciona sync_version (bigint NOT NULL), índice e trigger à tabela. Linhas já existentes recebem
// valores da sequência global antes de a coluna virar NOT NULL.
export async function addSyncVersionTrigger(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  await qr.query(`ALTER TABLE "${table}" ADD COLUMN "sync_version" bigint`);
  await qr.query(
    `UPDATE "${table}" SET "sync_version" = nextval('sync_version_seq')`,
  );
  await qr.query(
    `ALTER TABLE "${table}" ALTER COLUMN "sync_version" SET NOT NULL`,
  );
  await qr.query(
    `CREATE INDEX "ix_${table}_sync_version" ON "${table}" ("sync_version")`,
  );
  await qr.query(
    `CREATE TRIGGER "trg_${table}_sync_version" BEFORE INSERT OR UPDATE ON "${table}" ` +
      `FOR EACH ROW EXECUTE FUNCTION set_sync_version()`,
  );
}

export async function dropSyncVersionTrigger(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  await qr.query(
    `DROP TRIGGER IF EXISTS "trg_${table}_sync_version" ON "${table}"`,
  );
  await qr.query(`DROP INDEX IF EXISTS "ix_${table}_sync_version"`);
  await qr.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "sync_version"`);
}

const ORG_SETTING = `NULLIF(current_setting('app.organization_id', true), '')::uuid`;

// Isolamento por organização: sem `app.organization_id` na transação, nenhuma linha é visível nem gravável.
// FORCE vale também para o dono da tabela (exceto superusuário, que sempre ignora RLS).
export async function enableOrganizationRls(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  await qr.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
  await qr.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  await qr.query(
    `CREATE POLICY "org_isolation" ON "${table}" ` +
      `USING (organization_id = ${ORG_SETTING}) WITH CHECK (organization_id = ${ORG_SETTING})`,
  );
}

export async function disableOrganizationRls(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  await qr.query(`DROP POLICY IF EXISTS "org_isolation" ON "${table}"`);
  await qr.query(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
  await qr.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);
}

// SUBSTITUÍDO por `addCommitOrderedSyncVersion` (migration ConversationFeedCommitOrder); só a migration
// ConversationFeedSafeHorizon (e o `down` da que a substituiu) usa estas funções. Versões de feed na ordem dos xids:
// `xid8 da transação que grava << 16 | n` (n = linha na transação, satura em 65535). Problemas que levaram à troca:
// uma transação longa em qualquer lugar do cluster segurava todos os feeds (o limite era `pg_snapshot_xmin`), um
// restore lógico/cluster novo recomeça os xids, e mais de 65.535 linhas numa transação empatavam na mesma versão.
export async function useXidSyncVersion(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  await qr.query(`DROP TRIGGER "trg_${table}_sync_version" ON "${table}"`);
  await qr.query(
    `CREATE TRIGGER "trg_${table}_sync_version" BEFORE INSERT OR UPDATE ON "${table}" ` +
      `FOR EACH ROW EXECUTE FUNCTION set_xid_sync_version()`,
  );
}

export async function useSequenceSyncVersion(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  await qr.query(`DROP TRIGGER "trg_${table}_sync_version" ON "${table}"`);
  await qr.query(
    `CREATE TRIGGER "trg_${table}_sync_version" BEFORE INSERT OR UPDATE ON "${table}" ` +
      `FOR EACH ROW EXECUTE FUNCTION set_sync_version()`,
  );
}

/** Bits of the per-transaction row counter in a xid-ordered `sync_version` (`useXidSyncVersion`). */
export const XID_SYNC_VERSION_SHIFT = 16;

/**
 * A group of tables whose `sync_version` comes from ONE sequence, assigned AT COMMIT under ONE advisory lock
 * (`addCommitOrderedSyncVersion`). A reader that saw version V has seen every committed row of the group with a version
 * <= V. `lockKey` is the `pg_advisory_xact_lock` key (decimal string of a bigint), unique per feed.
 */
export type CommitOrderedSyncFeed = { sequence: string; lockKey: string };

/** The conversation feeds (migration ConversationFeedCommitOrder): "SYNCCONV" in ASCII. */
export const CONVERSATION_SYNC_FEED: CommitOrderedSyncFeed = {
  sequence: 'conversation_sync_version_seq',
  lockKey: '6005917628874313302',
};

const SYNC_COMMIT_ESCAPE = 'sync_commit_in_progress()';
/** Prefix of the policy COMMENT that keeps the expression a policy had before the escape (for the down migration). */
const ORIGINAL_POLICY_PREFIX = 'sync-commit-original:';

/** The BEFORE trigger of a commit-ordered table: `zz` so it fires LAST among the BEFORE triggers (name order). */
export const commitOrderedSyncTrigger = (table: string) =>
  `trg_${table}_zz_sync_version`;

/**
 * The shared functions of the commit-ordered versions (once per database; `addCommitOrderedSyncVersion` per table):
 * - `sync_commit_in_progress()`: true only INSIDE the commit-time UPDATE of `assign_commit_sync_version` (the flag
 *   `app.sync_commit`, set and cleared around that one statement, AND `pg_trigger_depth() > 0`: a client that sets the
 *   flag itself, at depth 0, gets nothing). It is the RLS escape of that UPDATE (see `addCommitOrderedSyncVersion`);
 * - `mark_sync_pending()` (BEFORE INSERT/UPDATE): every write leaves the row PROVISIONAL (`sync_pending = true`; a new
 *   row gets the placeholder version 0, an update keeps its last committed version), so it is never served before its
 *   version exists. Inside the commit-time UPDATE (`sync_commit_in_progress()`, depth > 1) it keeps the whole OLD row
 *   and changes ONLY `sync_version` and `sync_pending = false`: the escape can never write anything else;
 * - `assign_commit_sync_version(lockKey, sequence)` (the DEFERRED constraint trigger): at commit, takes the feed's
 *   advisory transaction lock (re-entrant; held to the end of the transaction) and gives the row the next value of the
 *   sequence. Postgres makes a commit visible before releasing its locks, so a later transaction can only take the
 *   lock, and versions, after the earlier one is visible: versions follow commit order.
 *
 * COST: the advisory lock is held from the first version UPDATE to the very end of the commit: the rest of the
 * deferred triggers, the NOTIFY queue lock, the WAL flush (and a synchronous replica, if any) and the moment the
 * commit becomes visible. Commits that write to the feed are therefore SERIAL, fsync included; a transaction that
 * writes many rows (a cascade: deregister, unlink, organization exit; a retention batch) makes the other writers of the
 * feed wait at their COMMIT, holding their pool connection, for the whole of it. Keep bulk writes in bounded batches
 * (retention: `CONVERSATION_RETENTION_BATCH_ROWS`). A `lock_timeout` set by the transaction also bounds this wait
 * (55P03 raised at COMMIT).
 *
 * NEVER `SET CONSTRAINTS ... IMMEDIATE` nor two-phase commit (PREPARE TRANSACTION) in a transaction that writes these
 * tables: both take the advisory lock BEFORE the end of the transaction (immediate: at that statement, still taking row
 * locks afterwards; prepared: held until COMMIT PREPARED), which breaks "the advisory lock is the last lock" and can
 * deadlock or stall every feed writer.
 */
export async function createCommitOrderedSyncFunctions(
  qr: QueryRunner,
): Promise<void> {
  await qr.query(`
    CREATE FUNCTION sync_commit_in_progress() RETURNS boolean AS $$
      SELECT COALESCE(current_setting('app.sync_commit', true), '') = 'on' AND pg_trigger_depth() > 0
    $$ LANGUAGE sql STABLE SECURITY INVOKER
  `);
  await qr.query(`
    CREATE FUNCTION mark_sync_pending() RETURNS trigger AS $$
    DECLARE
      v bigint;
    BEGIN
      IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 AND sync_commit_in_progress() THEN
        v := NEW.sync_version;
        NEW := OLD;
        NEW.sync_version := v;
        NEW.sync_pending := false;
        RETURN NEW;
      END IF;
      NEW.sync_pending := true;
      IF TG_OP = 'INSERT' THEN
        NEW.sync_version := 0;
      ELSE
        NEW.sync_version := OLD.sync_version;
      END IF;
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql SECURITY INVOKER
  `);
  await qr.query(`
    CREATE FUNCTION assign_commit_sync_version() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(TG_ARGV[0]::bigint);
      PERFORM set_config('app.sync_commit', 'on', true);
      EXECUTE format(
        'UPDATE %I.%I SET sync_version = nextval(%L::regclass), sync_pending = false WHERE id = $1 AND sync_pending',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[1]
      ) USING NEW.id;
      PERFORM set_config('app.sync_commit', '', true);
      RETURN NULL;
    END
    $$ LANGUAGE plpgsql SECURITY INVOKER
  `);
}

export async function dropCommitOrderedSyncFunctions(
  qr: QueryRunner,
): Promise<void> {
  await qr.query(`DROP FUNCTION assign_commit_sync_version()`);
  await qr.query(`DROP FUNCTION mark_sync_pending()`);
  await qr.query(`DROP FUNCTION sync_commit_in_progress()`);
}

/** Creates the feed's sequence above every version already served (`startAbove`), so existing cursors keep working. */
export async function createCommitOrderedSyncFeed(
  qr: QueryRunner,
  feed: CommitOrderedSyncFeed,
  startAbove: bigint,
): Promise<void> {
  await qr.query(
    `CREATE SEQUENCE "${feed.sequence}" START WITH ${(startAbove + 1n).toString()}`,
  );
  await qr.query(
    `GRANT USAGE, SELECT ON SEQUENCE "${feed.sequence}" TO app_runtime`,
  );
}

/**
 * Commit-ordered versions on a table that already has `sync_version` (`addSyncVersionTrigger`) and an `id` primary
 * key; `createCommitOrderedSyncFunctions` and `createCommitOrderedSyncFeed` first. Replaces the "version at write time"
 * of the global sequence (commit order × sync_version, Pendências do CLAUDE.md), with no dependency on other
 * transactions, xids or the cluster:
 * - column `sync_pending` (NOT NULL DEFAULT true; existing rows false) and the BEFORE trigger
 *   `trg_<t>_zz_sync_version` (`commitOrderedSyncTrigger`) on `mark_sync_pending()` (provisional on every write). It
 *   replaces `trg_<t>_sync_version`; the `zz` keeps it the LAST BEFORE trigger (Postgres fires them in name order), so
 *   in the commit-time UPDATE nothing after it can change the row it rebuilt from OLD. A new BEFORE trigger on the table
 *   must sort before it;
 * - `trg_<t>_sync_commit`: CONSTRAINT TRIGGER AFTER INSERT OR UPDATE, DEFERRABLE INITIALLY DEFERRED, FOR EACH ROW,
 *   WHEN (NEW.sync_pending): at commit, `assign_commit_sync_version` (advisory lock of the feed, then the version). The
 *   WHEN and `sync_pending = false` keep it from firing again for its own UPDATE; a row written again later in the same
 *   transaction is provisional again and gets a new version at commit (Postgres fires deferred triggers until none
 *   is left). The advisory lock is taken at commit, after every row lock of the transaction: it is always the LAST
 *   lock, so it adds no wait cycle; commits of the feed serialize from their version UPDATEs to the end of the commit
 *   (see COST in `createCommitOrderedSyncFunctions`);
 * - RLS: the commit-time UPDATE runs in whatever context the transaction has at commit (`withContext` restores the
 *   outer one; the writer may no longer see a row it just wrote, e.g. who leaves a conversation, or nobody does, the
 *   last participant leaving). Without SECURITY DEFINER: permissive policies `sync_commit_read` (SELECT) and
 *   `sync_commit_update` (UPDATE) on `sync_commit_in_progress()`, and the same escape OR-ed into every RESTRICTIVE
 *   SELECT/UPDATE/ALL policy of the table (the original expressions are kept in the policy's COMMENT, prefixed with
 *   `sync-commit-original:`, for `dropCommitOrderedSyncVersion`). A policy (re)created on the table later must keep
 *   the escape: without it the commit-time UPDATE silently changes 0 rows and the row stays provisional (never served).
 *   Pinned by `test/conversations/commit-order-invariants.e2e-spec.ts` and the e2e global teardown;
 * - readers serve only `sync_pending = false` (always true of committed rows; documents intent);
 * - other AFTER triggers on the table fire for the commit-time UPDATE too (it changes only the two sync columns): make
 *   them `UPDATE OF <columns>` or `WHEN (NEW.sync_pending)` when they lock or write, so nothing else is locked after
 *   the advisory lock.
 */
export async function addCommitOrderedSyncVersion(
  qr: QueryRunner,
  table: string,
  feed: CommitOrderedSyncFeed,
): Promise<void> {
  await qr.query(
    `ALTER TABLE "${table}" ADD COLUMN "sync_pending" boolean NOT NULL DEFAULT false`,
  );
  await qr.query(
    `ALTER TABLE "${table}" ALTER COLUMN "sync_pending" SET DEFAULT true`,
  );
  await qr.query(`DROP TRIGGER "trg_${table}_sync_version" ON "${table}"`);
  await qr.query(
    `CREATE TRIGGER "${commitOrderedSyncTrigger(table)}" BEFORE INSERT OR UPDATE ON "${table}" ` +
      `FOR EACH ROW EXECUTE FUNCTION mark_sync_pending()`,
  );
  await qr.query(
    `CREATE CONSTRAINT TRIGGER "trg_${table}_sync_commit" AFTER INSERT OR UPDATE ON "${table}" ` +
      `DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.sync_pending) ` +
      `EXECUTE FUNCTION assign_commit_sync_version('${feed.lockKey}', '${feed.sequence}')`,
  );
  await qr.query(
    `CREATE POLICY "sync_commit_read" ON "${table}" FOR SELECT USING (${SYNC_COMMIT_ESCAPE})`,
  );
  await qr.query(
    `CREATE POLICY "sync_commit_update" ON "${table}" FOR UPDATE ` +
      `USING (${SYNC_COMMIT_ESCAPE}) WITH CHECK (${SYNC_COMMIT_ESCAPE})`,
  );
  const policies = (await qr.query(
    `SELECT policyname, qual, with_check FROM pg_policies
      WHERE schemaname = current_schema() AND tablename = $1 AND permissive = 'RESTRICTIVE'
        AND cmd IN ('SELECT', 'UPDATE', 'ALL')
      ORDER BY policyname`,
    [table],
  )) as {
    policyname: string;
    qual: string | null;
    with_check: string | null;
  }[];
  for (const p of policies) {
    const using =
      p.qual === null ? '' : ` USING (${SYNC_COMMIT_ESCAPE} OR (${p.qual}))`;
    const check =
      p.with_check === null
        ? ''
        : ` WITH CHECK (${SYNC_COMMIT_ESCAPE} OR (${p.with_check}))`;
    await qr.query(
      `ALTER POLICY "${p.policyname}" ON "${table}"${using}${check}`,
    );
    const original =
      ORIGINAL_POLICY_PREFIX +
      JSON.stringify({ qual: p.qual, withCheck: p.with_check });
    await qr.query(
      `COMMENT ON POLICY "${p.policyname}" ON "${table}" IS '${original.replaceAll("'", "''")}'`,
    );
  }
}

/** Undoes `addCommitOrderedSyncVersion`; the caller recreates the BEFORE trigger `trg_<t>_sync_version`. */
export async function dropCommitOrderedSyncVersion(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  const policies = (await qr.query(
    `SELECT pol.polname AS name, d.description
       FROM pg_policy pol JOIN pg_description d ON d.objoid = pol.oid AND d.classoid = 'pg_policy'::regclass
      WHERE pol.polrelid = $1::regclass AND starts_with(d.description, $2)`,
    [table, ORIGINAL_POLICY_PREFIX],
  )) as { name: string; description: string }[];
  for (const p of policies) {
    const original = JSON.parse(
      p.description.slice(ORIGINAL_POLICY_PREFIX.length),
    ) as {
      qual: string | null;
      withCheck: string | null;
    };
    const using = original.qual === null ? '' : ` USING (${original.qual})`;
    const check =
      original.withCheck === null ? '' : ` WITH CHECK (${original.withCheck})`;
    await qr.query(`ALTER POLICY "${p.name}" ON "${table}"${using}${check}`);
    await qr.query(`COMMENT ON POLICY "${p.name}" ON "${table}" IS NULL`);
  }
  await qr.query(`DROP POLICY "sync_commit_update" ON "${table}"`);
  await qr.query(`DROP POLICY "sync_commit_read" ON "${table}"`);
  await qr.query(`DROP TRIGGER "trg_${table}_sync_commit" ON "${table}"`);
  await qr.query(
    `DROP TRIGGER "${commitOrderedSyncTrigger(table)}" ON "${table}"`,
  );
  await qr.query(`ALTER TABLE "${table}" DROP COLUMN "sync_pending"`);
}
