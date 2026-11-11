import { JOB_QUEUE_SCHEMA, pgBossConstructionSql } from './pg-boss-schema.js';

describe('pgBossConstructionSql', () => {
  it('installs into the pgboss schema without its own transaction (the migration has one)', () => {
    const sql = pgBossConstructionSql();
    expect(JOB_QUEUE_SCHEMA).toBe('pgboss');
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS pgboss');
    expect(sql).toMatch(/INSERT INTO pgboss\.version\(version\) VALUES/);
    expect(sql.trim().startsWith('BEGIN')).toBe(false);
    expect(sql.trim().endsWith('COMMIT;')).toBe(false);
  });
});
