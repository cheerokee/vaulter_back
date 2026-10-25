import { DataSource } from 'typeorm';
import { typeOrmOptions } from '../../src/database/typeorm.options.js';
import { PostgresThrottlerStorage } from '../../src/shared/infra/http/postgres-throttler.storage.js';
import { adminDataSource, resetDatabase } from '../setup/test-app.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('PostgresThrottlerStorage (integration)', () => {
  let a: DataSource;
  let b: DataSource;
  let storage: PostgresThrottlerStorage;

  beforeAll(async () => {
    a = new DataSource(typeOrmOptions('app'));
    b = new DataSource(typeOrmOptions('app'));
    await Promise.all([a.initialize(), b.initialize()]);
    storage = new PostgresThrottlerStorage(a, { cleanupProbability: 0 });
  });

  afterAll(async () => {
    await Promise.all([a.destroy(), b.destroy()]);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('counts hits and blocks only past the limit', async () => {
    const r1 = await storage.increment('k', 60_000, 2, 60_000, 't');
    expect(r1).toMatchObject({ totalHits: 1, isBlocked: false });
    expect(r1.timeToExpire).toBeGreaterThan(0);
    expect(r1.timeToExpire).toBeLessThanOrEqual(60);
    expect(
      (await storage.increment('k', 60_000, 2, 60_000, 't')).isBlocked,
    ).toBe(false);
    const r3 = await storage.increment('k', 60_000, 2, 60_000, 't');
    expect(r3.isBlocked).toBe(true);
    expect(r3.timeToBlockExpire).toBeGreaterThan(0);
    expect(r3.timeToBlockExpire).toBeLessThanOrEqual(60);
  });

  it('keeps different throttler names and keys apart', async () => {
    await storage.increment('k', 60_000, 5, 60_000, 'one');
    await storage.increment('k', 60_000, 5, 60_000, 'one');
    expect(
      (await storage.increment('k', 60_000, 5, 60_000, 'two')).totalHits,
    ).toBe(1);
    expect(
      (await storage.increment('other', 60_000, 5, 60_000, 'one')).totalHits,
    ).toBe(1);
  });

  it('counts concurrent increments exactly', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        storage.increment('c', 60_000, 1000, 60_000, 't'),
      ),
    );
    expect(results.map((r) => r.totalHits).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  });

  it('blocks exactly the calls past the limit under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        storage.increment('c2', 60_000, 10, 60_000, 't'),
      ),
    );
    expect(results.filter((r) => !r.isBlocked)).toHaveLength(10);
  });

  it('shares the counter between two DataSources', async () => {
    const other = new PostgresThrottlerStorage(b, { cleanupProbability: 0 });
    await storage.increment('s', 60_000, 3, 60_000, 't');
    await other.increment('s', 60_000, 3, 60_000, 't');
    await storage.increment('s', 60_000, 3, 60_000, 't');
    expect((await other.increment('s', 60_000, 3, 60_000, 't')).isBlocked).toBe(
      true,
    );
  });

  it('does not count hits while blocked and unblocks after blockDuration', async () => {
    await storage.increment('b', 60_000, 1, 300, 't');
    const blocked = await storage.increment('b', 60_000, 1, 300, 't');
    expect(blocked.isBlocked).toBe(true);
    expect((await storage.increment('b', 60_000, 1, 300, 't')).isBlocked).toBe(
      true,
    );
    await sleep(400);
    const after = await storage.increment('b', 60_000, 1, 300, 't');
    expect(after).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('starts a new window after ttl', async () => {
    await storage.increment('w', 200, 5, 200, 't');
    await storage.increment('w', 200, 5, 200, 't');
    await sleep(300);
    expect((await storage.increment('w', 200, 5, 200, 't')).totalHits).toBe(1);
  });

  it('opportunistically deletes expired rows (runtime role may DELETE)', async () => {
    const cleaner = new PostgresThrottlerStorage(a, { cleanupProbability: 1 });
    await cleaner.increment('old', 50, 5, 50, 't');
    await sleep(150);
    await cleaner.increment('new', 60_000, 5, 60_000, 't');
    await sleep(100); // cleanup is fire-and-forget
    const admin = await adminDataSource();
    const rows: { key: string }[] = await admin.query(
      'SELECT key FROM rate_limit_hits',
    );
    expect(rows.map((r) => r.key)).toEqual(['t:new']);
  });
});
