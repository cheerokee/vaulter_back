import type { INestApplication } from '@nestjs/common';
import { vi } from 'vitest';
import {
  JobQueue,
  type JobPayload,
} from '../../src/shared/application/job-queue.js';
import { DomainValidationError } from '../../src/shared/domain/errors.js';
import { newId } from '../../src/shared/domain/id.js';
import { UnitOfWork } from '../../src/shared/infra/db/unit-of-work.js';
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
});
