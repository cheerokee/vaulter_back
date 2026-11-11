import type { JobQueue } from '../../../shared/application/job-queue.js';
import {
  ANSWER_CONVERSATION_QUEUE,
  CloudResponderQueue,
} from './cloud-responder-queue.js';

const ctx = {
  organizationId: '01900000-0000-7000-8000-000000000001',
  spaceId: '01900000-0000-7000-8000-000000000002',
  conversationId: '01900000-0000-7000-8000-000000000003',
  messageId: '01900000-0000-7000-8000-000000000004',
};
const payload = {
  organizationId: ctx.organizationId,
  spaceId: ctx.spaceId,
  conversationId: ctx.conversationId,
};

describe('CloudResponderQueue', () => {
  const jobs = { send: vi.fn(), sendMany: vi.fn() };
  const queue = new CloudResponderQueue(jobs as unknown as JobQueue);
  beforeEach(() => vi.clearAllMocks());

  it('a new message waits 30 s for the Hub, keeping an earlier waiting job (one per conversation)', async () => {
    await queue.onPending({ ...ctx, reason: 'sent', immediate: false });
    expect(jobs.sendMany).toHaveBeenCalledWith(ANSWER_CONVERSATION_QUEUE, [
      {
        payload,
        singletonKey: `conversation:${ctx.conversationId}`,
        startAfterSeconds: 30,
      },
    ]);
    expect(jobs.send).not.toHaveBeenCalled();
  });

  it('a message back in the queue (requeued) gives the new executor Hub its own 30 s', async () => {
    await queue.onPending({ ...ctx, reason: 'requeued', immediate: false });
    expect(jobs.sendMany).toHaveBeenCalledTimes(1);
    expect(jobs.send).not.toHaveBeenCalled();
    await queue.onPending({ ...ctx, reason: 'requeued', immediate: true });
    expect(jobs.send).toHaveBeenCalledTimes(1);
  });

  it('"responder pela nuvem" (or any other reason) starts now, moving a waiting job', async () => {
    for (const c of [
      { reason: 'sent' as const, immediate: true },
      { reason: 'reserve_enabled' as const, immediate: false },
      { reason: 'cloud_answer' as const, immediate: false },
    ]) {
      await queue.onPending({ ...ctx, ...c });
    }
    expect(jobs.send).toHaveBeenCalledTimes(3);
    expect(jobs.send).toHaveBeenCalledWith(ANSWER_CONVERSATION_QUEUE, payload, {
      singletonKey: `conversation:${ctx.conversationId}`,
      startAfterSeconds: 0,
    });
    expect(jobs.sendMany).not.toHaveBeenCalled();
  });
});
