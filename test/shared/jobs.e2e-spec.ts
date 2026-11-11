import type { INestApplication } from '@nestjs/common';
import { vi } from 'vitest';
import {
  JobQueue,
  type JobPayload,
} from '../../src/shared/application/job-queue.js';
import { DomainValidationError } from '../../src/shared/domain/errors.js';
import { newId } from '../../src/shared/domain/id.js';
import { UnitOfWork } from '../../src/shared/infra/db/unit-of-work.js';
import sodium from 'libsodium-wrappers-sumo';
import { ServerKeyring } from '../../src/cloud/application/ports/server-keyring.js';
import { ObjectStore } from '../../src/storage/application/ports/object-store.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';

interface JobRow {
  id: string;
  state: string;
  data: Record<string, unknown>;
  output: Record<string, unknown> | null;
  start_after: Date;
}

async function jobsOf(name: string): Promise<JobRow[]> {
  const admin = await adminDataSource();
  return admin.query(
    `SELECT id, state, data, output, start_after FROM pgboss.job WHERE name = $1 ORDER BY created_on`,
    [name],
  );
}

const withWorkers = { env: { JOB_WORKERS_ENABLED: 'true' } };

describe('job queue (e2e, pg-boss)', () => {
  let app: INestApplication | undefined;

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('a job enqueued by one process runs exactly once in another, after a restart', async () => {
    // Process 1: no workers (the e2e default). The job only waits in the database.
    app = await createTestApp();
    const spaceId = newId();
    const id = await app.get(JobQueue).send('test.restart', { spaceId });
    expect(id).toBeTruthy();
    await app.close();

    // Process 2: workers on; the job survived the restart and runs once.
    app = await createTestApp(withWorkers);
    const seen: { payload: JobPayload; retry: number }[] = [];
    await app.get(JobQueue).work('test.restart', async (payload, job) => {
      seen.push({ payload, retry: job.retryCount });
    });
    await vi.waitFor(
      async () =>
        expect((await jobsOf('test.restart'))[0]?.state).toBe('completed'),
      { timeout: 15_000, interval: 200 },
    );
    // Two more polling intervals: nothing runs it again.
    await new Promise((r) => setTimeout(r, 4_500));
    expect(seen).toEqual([{ payload: { spaceId }, retry: 0 }]);
    expect(await jobsOf('test.restart')).toHaveLength(1);
  }, 40_000);

  it('a job sent inside a unit of work exists only if the transaction commits', async () => {
    app = await createTestApp();
    const queue = app.get(JobQueue);
    const uow = app.get(UnitOfWork);
    const kept = newId();
    const dropped = newId();
    await uow.run(() => queue.send('test.tx', { objectId: kept }));
    await expect(
      uow.run(async () => {
        await queue.send('test.tx', { objectId: dropped });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const rows = await jobsOf('test.tx');
    expect(rows.map((r) => r.data)).toEqual([{ objectId: kept }]);
  });

  it('payloads carry only ids', async () => {
    app = await createTestApp();
    const queue = app.get(JobQueue);
    for (const bad of [
      { text: 'a confidential sentence' },
      { spaceId: 'not-a-uuid' },
      { version: 1.5 },
      { nested: { spaceId: newId() } },
    ]) {
      await expect(
        queue.send('test.ids', bad as unknown as JobPayload),
      ).rejects.toThrow(/UUID or a safe integer|plain object/);
    }
    await queue.send('test.ids', { spaceId: newId(), keyVersion: 3 });
    expect(await jobsOf('test.ids')).toHaveLength(1);
  });

  it('delays, deduplicates by key and cancels waiting jobs by payload', async () => {
    app = await createTestApp();
    const queue = app.get(JobQueue);
    const spaceA = newId();
    const spaceB = newId();
    const messageId = newId();

    const first = await queue.send(
      'test.fallback',
      { spaceId: spaceA, messageId },
      { startAfterSeconds: 30, singletonKey: messageId },
    );
    const again = await queue.send(
      'test.fallback',
      { spaceId: spaceA, messageId },
      { startAfterSeconds: 30, singletonKey: messageId },
    );
    expect(again).toBe(first);
    await queue.send('test.fallback', { spaceId: spaceA, messageId: newId() });
    await queue.send('test.fallback', { spaceId: spaceB, messageId: newId() });

    const rows = await jobsOf('test.fallback');
    expect(rows).toHaveLength(3);
    const delayed = rows.find((r) => r.id === first)!;
    expect(delayed.start_after.getTime() - Date.now()).toBeGreaterThan(20_000);

    expect(await queue.cancelQueued('test.fallback', { spaceId: spaceA })).toBe(
      2,
    );
    expect((await jobsOf('test.fallback')).map((r) => r.data)).toEqual([
      expect.objectContaining({ spaceId: spaceB }),
    ]);
  });

  it('a failing handler stores only the error type, never its message', async () => {
    app = await createTestApp(withWorkers);
    const queue = app.get(JobQueue);
    await queue.work('test.fail', async () => {
      throw new DomainValidationError(
        'extraction-failed',
        'could not parse: "salário da Ana: R$ 12.000"',
      );
    });
    await queue.send('test.fail', { objectId: newId() });
    await vi.waitFor(
      async () => {
        const [row] = await jobsOf('test.fail');
        expect(row?.output).toBeTruthy();
      },
      { timeout: 15_000, interval: 200 },
    );
    const [row] = await jobsOf('test.fail');
    const stored = JSON.stringify(row!.output);
    expect(stored).toContain('job failed: extraction-failed');
    expect(stored).not.toContain('salário');
  }, 30_000);

  it('a keyed queue keeps ONE waiting job per key (earliest start wins) and never runs two jobs of a key at once, across instances', async () => {
    const key = `conversation:${newId()}`;
    const payload = { spaceId: newId() };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started: string[] = [];
    const handler = async (_p: JobPayload, job: { id: string }) => {
      started.push(job.id);
      if (started.length === 1) await gate;
    };
    app = await createTestApp(withWorkers);
    const other = await createTestApp(withWorkers);
    try {
      await app
        .get(JobQueue)
        .work('test.keyed', handler, { oneJobPerKey: true });
      await other.get(JobQueue).work('test.keyed', handler, {
        oneJobPerKey: true,
      });
      const queue = app.get(JobQueue);
      // Keys are mandatory on a keyed queue; sendMany refuses keys on a standard one (it could not deduplicate).
      await expect(queue.send('test.keyed', payload)).rejects.toThrow(/keyed/);
      await expect(
        queue.sendMany('test.fallback', [{ payload, singletonKey: key }]),
      ).rejects.toThrow(/not keyed/);

      // Two inserts for one key: one waiting job, at the EARLIER start.
      expect(
        await queue.sendMany('test.keyed', [
          { payload, singletonKey: key, startAfterSeconds: 600 },
        ]),
      ).toBe(1);
      expect(
        await queue.sendMany('test.keyed', [
          { payload, singletonKey: key, startAfterSeconds: 300 },
        ]),
      ).toBe(0);
      expect(
        await queue.sendMany('test.keyed', [
          { payload, singletonKey: key, startAfterSeconds: 900 },
        ]),
      ).toBe(0);
      let rows = await jobsOf('test.keyed');
      expect(rows).toHaveLength(1);
      const delay = rows[0]!.start_after.getTime() - Date.now();
      expect(delay).toBeGreaterThan(250_000);
      expect(delay).toBeLessThan(310_000);

      // Now: it runs (held at the gate) in one of the two instances.
      await queue.send('test.keyed', payload, {
        singletonKey: key,
        startAfterSeconds: 0,
      });
      await vi.waitFor(() => expect(started).toHaveLength(1), {
        timeout: 15_000,
        interval: 200,
      });
      // A second job of the same key, due now: neither instance takes it while the first one runs.
      await other
        .get(JobQueue)
        .sendMany('test.keyed', [{ payload, singletonKey: key }]);
      await new Promise((r) => setTimeout(r, 6_000));
      expect(started).toHaveLength(1);
      rows = await jobsOf('test.keyed');
      expect(rows.map((r) => r.state).sort()).toEqual(['active', 'created']);
      release();
      await vi.waitFor(() => expect(started).toHaveLength(2), {
        timeout: 15_000,
        interval: 200,
      });
    } finally {
      release();
      await other.close();
    }
  }, 60_000);

  it('cancelQueued never deletes a running job, and is undone with its unit of work', async () => {
    app = await createTestApp();
    const queue = app.get(JobQueue);
    const uow = app.get(UnitOfWork);
    const spaceId = newId();
    for (let i = 0; i < 3; i++) {
      await queue.send('test.cancel', { spaceId, objectId: newId() });
    }
    // One of them is running (as a worker's fetch leaves it).
    const admin = await adminDataSource();
    const [running] = await jobsOf('test.cancel');
    await admin.query(
      `UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = $1`,
      [running!.id],
    );

    await expect(
      uow.run(async () => {
        expect(await queue.cancelQueued('test.cancel', { spaceId })).toBe(2);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await jobsOf('test.cancel')).toHaveLength(3);

    expect(
      await uow.run(() => queue.cancelQueued('test.cancel', { spaceId })),
    ).toBe(2);
    const left = await jobsOf('test.cancel');
    expect(left.map((r) => [r.id, r.state])).toEqual([[running!.id, 'active']]);
  });

  it('shutdown drains running jobs before anything they use is released', async () => {
    await sodium.ready;
    app = await createTestApp(withWorkers);
    const queue = app.get(JobQueue);
    const keyring = app.get(ServerKeyring);
    const objectStore = app.get(ObjectStore) as ObjectStore & {
      onModuleDestroy: () => void;
    };
    const s3Released = vi.spyOn(objectStore, 'onModuleDestroy');
    const spaceKey = sodium.randombytes_buf(32);
    const copy = Buffer.concat([
      Buffer.from([0x01]),
      sodium.crypto_box_seal(
        spaceKey,
        Buffer.from(await keyring.publicKey(), 'base64url'),
      ),
    ]).toString('base64url');

    let started!: () => void;
    const handlerStarted = new Promise<void>((r) => (started = r));
    let closing!: () => void;
    const closeStarted = new Promise<void>((r) => (closing = r));
    const result: { opened?: boolean; s3ReleasedFirst?: boolean } = {};
    await queue.work('test.drain', async () => {
      started();
      await closeStarted;
      // The application is closing: keep working a little, then use the key and look at the S3 client.
      await new Promise((r) => setTimeout(r, 300));
      const key = await keyring.openSealed(copy);
      result.opened = Buffer.from(key).equals(Buffer.from(spaceKey));
      result.s3ReleasedFirst = s3Released.mock.calls.length > 0;
    });
    await queue.send('test.drain', { spaceId: newId() });
    await handlerStarted;

    const closed = app.close();
    closing();
    await closed;
    app = undefined;
    expect(result).toEqual({ opened: true, s3ReleasedFirst: false });
    expect(s3Released).toHaveBeenCalledTimes(1);
    expect((await jobsOf('test.drain'))[0]?.state).toBe('completed');
  }, 30_000);
});
