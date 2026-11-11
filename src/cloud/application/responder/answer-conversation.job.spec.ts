import { DomainValidationError } from '../../../shared/domain/errors.js';
import { newId } from '../../../shared/domain/id.js';
import type { CloudConversationExecutor } from '../../../conversations/application/cloud-conversation-executor.js';
import { AiPricing } from '../../domain/ai-pricing.js';
import {
  answerIdFor,
  CLOUD_GIVE_UP_RETRY_AFTER_MS,
} from '../../domain/responder.js';
import { FakeEmbedder } from '../../testing/fake-embedder.js';
import { FakeLanguageModel } from '../../testing/fake-language-model.js';
import type { AiBudget } from '../ai-budget.js';
import type { CloudCipher } from '../ports/cloud-cipher.js';
import type { ServerKeyring } from '../ports/server-keyring.js';
import { AnswerConversationJob } from './answer-conversation.job.js';
import type { CloudDocumentWriter } from './cloud-document-writer.js';
import type { CloudResponderQueue } from './cloud-responder-queue.js';
import type { ResponderClock } from './responder-clock.js';

const ORG = newId();
const SPACE = newId();
const CONV = newId();
const NOW = new Date('2026-11-11T12:00:00.000Z');

function setup(messages: Record<string, unknown>[]) {
  const executor = {
    read: vi.fn().mockResolvedValue({
      conversation: {
        id: CONV,
        organizationId: ORG,
        spaceId: SPACE,
        executorHubId: newId(),
        cloudAnswer: false,
        keyRotationRequired: false,
        currentKeyVersion: 1,
      },
      serverKeyCopies: [{ keyVersion: 1, wrappedKey: 'copy' }],
      messages,
    }),
    ack: vi.fn().mockResolvedValue('acked'),
    release: vi.fn().mockResolvedValue([]),
    send: vi.fn().mockRejectedValue(
      new DomainValidationError('space-storage-full', 'full', {
        missingBytes: 10,
      }),
    ),
  };
  const budget = {
    tryReserve: vi
      .fn()
      .mockResolvedValue({ refusal: { resetsAt: new Date() } }),
    release: vi.fn(),
    settle: vi.fn(),
  };
  const queue = { now: vi.fn(), later: vi.fn() };
  const llm = new FakeLanguageModel();
  const job = new AnswerConversationJob(
    executor as unknown as CloudConversationExecutor,
    {
      openSealed: vi.fn().mockResolvedValue(new Uint8Array(32)),
    } as unknown as ServerKeyring,
    {
      sealMessage: vi.fn().mockResolvedValue(new Uint8Array(64)),
      openMessage: vi.fn(),
    } as unknown as CloudCipher,
    new FakeEmbedder(),
    { search: vi.fn() } as never,
    { audience: vi.fn() } as never,
    llm,
    new AiPricing(),
    budget as unknown as AiBudget,
    {} as CloudDocumentWriter,
    queue as unknown as CloudResponderQueue,
    { now: vi.fn().mockResolvedValue(NOW) } as unknown as ResponderClock,
  );
  return { job, executor, budget, queue, llm };
}

const person = (extra: Record<string, unknown>) => ({
  id: newId(),
  authorUserId: newId(),
  authorHubId: null,
  authorCloud: false,
  keyVersion: 1,
  encryptedBody: 'AAAA',
  replacesMessageId: null,
  pending: true,
  ackedByCloud: false,
  cloudAnswerRequested: false,
  requeuedAt: null,
  sentAt: new Date(NOW.getTime() - 60_000),
  ...extra,
});

describe('AnswerConversationJob (termination)', () => {
  it('resume + budget refused + the notice cannot be delivered: one attempt, stops (no loop, no fresh job)', async () => {
    const mine = person({ pending: false, ackedByCloud: true });
    const { job, executor, queue, llm } = setup([mine]);
    await job.run({
      organizationId: ORG,
      spaceId: SPACE,
      conversationId: CONV,
    });
    expect(executor.read).toHaveBeenCalledTimes(1);
    expect(executor.send).toHaveBeenCalledTimes(1);
    expect(executor.send.mock.calls[0]![3].id).toBe(answerIdFor(mine.id));
    expect(queue.now).not.toHaveBeenCalled();
    expect(llm.calls).toHaveLength(0);
  });

  it('an answer that cannot be delivered after the model ran (space full): stops, paid once, settled', async () => {
    const mine = person({ pending: false, ackedByCloud: true });
    const { job, executor, queue, llm, budget } = setup([mine]);
    budget.tryReserve.mockResolvedValue({
      reservation: { id: newId(), organizationId: ORG },
    });
    // The history opens (plain text body).
    const cipher = (
      job as unknown as { cipher: { openMessage: ReturnType<typeof vi.fn> } }
    ).cipher;
    cipher.openMessage.mockResolvedValue(new TextEncoder().encode('oi'));
    (
      job as unknown as { spaceCloud: { audience: ReturnType<typeof vi.fn> } }
    ).spaceCloud.audience.mockResolvedValue({
      people: 1,
      roles: [],
      roomHubs: 0,
    });
    (
      job as unknown as { chunks: { search: ReturnType<typeof vi.fn> } }
    ).chunks.search.mockResolvedValue([]);
    await job.run({
      organizationId: ORG,
      spaceId: SPACE,
      conversationId: CONV,
    });
    expect(llm.calls).toHaveLength(1);
    expect(executor.read).toHaveBeenCalledTimes(1);
    expect(budget.settle).toHaveBeenCalledTimes(1);
    expect(queue.now).not.toHaveBeenCalled();
  });
});

describe('AnswerConversationJob (retries exhausted)', () => {
  const payload = { organizationId: ORG, spaceId: SPACE, conversationId: CONV };
  const failingRead = () => {
    const k = setup([]);
    k.executor.read.mockRejectedValue(new Error('embeddings down'));
    return k;
  };

  it('a failure with retries left: rethrown, nothing given back (the retry resumes the held message)', async () => {
    const { job, executor, queue } = failingRead();
    await expect(job.run(payload, { lastAttempt: false })).rejects.toThrow(
      'embeddings down',
    );
    expect(executor.release).not.toHaveBeenCalled();
    expect(queue.later).not.toHaveBeenCalled();
  });

  it('the last attempt fails: the held message goes back to pending and the conversation is looked at later', async () => {
    const { job, executor, queue } = failingRead();
    const held = newId();
    executor.release.mockResolvedValue([held]);
    await expect(job.run(payload, { lastAttempt: true })).rejects.toThrow(
      'embeddings down',
    );
    expect(executor.release).toHaveBeenCalledWith(ORG, SPACE, CONV);
    expect(queue.later).toHaveBeenCalledWith(
      payload,
      CLOUD_GIVE_UP_RETRY_AFTER_MS / 1000,
    );
  });

  it('a failing give-up never hides the original error', async () => {
    const { job, executor } = failingRead();
    executor.release.mockRejectedValue(new Error('db down'));
    await expect(job.run(payload, { lastAttempt: true })).rejects.toThrow(
      'embeddings down',
    );
  });
});
