import { getConstructionPlans } from 'pg-boss';

/** The pg-boss schema (its own, outside `public`: TypeORM and `schema:check` never look at it). */
export const JOB_QUEUE_SCHEMA = 'pgboss';

/**
 * The SQL that installs pg-boss into `JOB_QUEUE_SCHEMA`, at the schema version of the pg-boss package installed
 * (pinned by package-lock), without the `BEGIN`/`COMMIT` pg-boss wraps it in: the migration runs it inside its own
 * transaction. Run by the OWNER login in a migration, never by the API (the runtime login has no DDL right; pg-boss
 * starts with `migrate: false`).
 *
 * Upgrading pg-boss to a release with a new schema version: a new migration that reads `pgboss.version` and, when it
 * is below the package's, runs `getMigrationPlans` (owner login); a database created afterwards already gets the new
 * version here and that migration is a no-op for it. Until then the API refuses to start (pg-boss checks the
 * version on `start`).
 */
export function pgBossConstructionSql(): string {
  const sql = getConstructionPlans(JOB_QUEUE_SCHEMA).trim();
  if (!sql.startsWith('BEGIN;') || !sql.endsWith('COMMIT;')) {
    throw new Error(
      'pg-boss construction plan changed shape (expected BEGIN; ... COMMIT;): review the migration',
    );
  }
  return sql.slice('BEGIN;'.length, -'COMMIT;'.length);
}
