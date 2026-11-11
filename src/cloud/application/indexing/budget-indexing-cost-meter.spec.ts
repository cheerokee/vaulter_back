import { AiPricing } from '../../domain/ai-pricing.js';
import { FakeEmbedder } from '../../testing/fake-embedder.js';
import type { AiBudget, OnAiReservationRefused } from '../ai-budget.js';
import { BudgetIndexingCostMeter } from './budget-indexing-cost-meter.js';
import type { CloudIndexingQueue } from './cloud-indexing-queue.js';

const SCOPE = { organizationId: 'o', spaceId: 's', cloudFileId: 'f' };

describe('BudgetIndexingCostMeter', () => {
  const reservation = {
    id: 'r1',
    organizationId: 'o',
    spaceId: 's',
    kind: 'indexing' as const,
    month: '2026-11-01',
    amountMicroUsd: 1n,
  };
  const setup = () => {
    const budget = {
      tryReserve: vi.fn(),
      settle: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const queue = { enqueueSpaceResume: vi.fn(async () => undefined) };
    const meter = new BudgetIndexingCostMeter(
      budget as unknown as AiBudget,
      new AiPricing(),
      new FakeEmbedder(),
      queue as unknown as CloudIndexingQueue,
    );
    return { budget, queue, meter };
  };

  it('reserves an over-estimate of the batch (1 token / 2 chars, embedding price) as `indexing`', async () => {
    const k = setup();
    k.budget.tryReserve.mockResolvedValueOnce({ reservation });
    // 2 texts of 2_000_000 chars -> 2_000_000 tokens x $0.10/MTok (fake-embedding) = 200_000 micro-USD.
    const charge = await k.meter.reserve(SCOPE, [
      'x'.repeat(2_000_000),
      'y'.repeat(2_000_000),
    ]);
    expect(charge).toEqual({ reservationId: 'r1', reservation });
    expect(k.budget.tryReserve).toHaveBeenCalledWith(
      {
        organizationId: 'o',
        spaceId: 's',
        kind: 'indexing',
        estimatedMicroUsd: 200_000n,
      },
      expect.any(Function),
    );
    await k.meter.settle(charge!, {
      model: 'fake-embedding',
      inputTokens: 7,
      costMicroUsd: 3n,
    });
    expect(k.budget.settle).toHaveBeenCalledWith(reservation, {
      model: 'fake-embedding',
      inputTokens: 7,
      outputTokens: 0,
      costMicroUsd: 3n,
    });
    await k.meter.release(charge!);
    expect(k.budget.release).toHaveBeenCalledWith(reservation);
  });

  it('refused: null, and the refusing transaction schedules the space pass for the next month (+60 s)', async () => {
    const k = setup();
    const resetsAt = new Date(Date.now() + 3_600_000);
    k.budget.tryReserve.mockImplementationOnce(
      async (_r: unknown, onRefused: OnAiReservationRefused) => {
        await onRefused({ resetsAt });
        return { refusal: { resetsAt } };
      },
    );
    await expect(k.meter.reserve(SCOPE, ['a'])).resolves.toBeNull();
    const [org, space, seconds] = k.queue.enqueueSpaceResume.mock
      .calls[0] as unknown as [string, string, number];
    expect([org, space]).toEqual(['o', 's']);
    expect(seconds).toBeGreaterThanOrEqual(3_658);
    expect(seconds).toBeLessThanOrEqual(3_661);
  });
});
