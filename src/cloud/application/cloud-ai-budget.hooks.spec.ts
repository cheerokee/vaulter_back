import { OrganizationAiSpend } from '../../organizations/application/organization-ai-spend.js';
import { AiBudgetRaisedHooks } from '../../shared/application/ai-budget-raised-hooks.js';
import type { CloudFileRepository } from '../domain/indexing.repositories.js';
import type { AiBudget } from './ai-budget.js';
import { CloudAiBudgetHooks } from './cloud-ai-budget.hooks.js';
import type { CloudIndexingQueue } from './indexing/cloud-indexing-queue.js';

describe('CloudAiBudgetHooks', () => {
  it('a raise enqueues, at once, the pass of every space with a pending file; the spend source feeds the org view', async () => {
    const spend = new OrganizationAiSpend();
    const raised = new AiBudgetRaisedHooks();
    const budget = { consumedMicroUsd: vi.fn(async () => 42n) };
    const files = { spacesWithPending: vi.fn(async () => ['s1', 's2']) };
    const queue = { enqueueSpace: vi.fn(async () => undefined) };
    const hooks = new CloudAiBudgetHooks(
      spend,
      raised,
      budget as unknown as AiBudget,
      files as unknown as CloudFileRepository,
      queue as unknown as CloudIndexingQueue,
    );
    hooks.onModuleInit();
    await raised.run({ organizationId: 'o', fromMicroUsd: 1n, toMicroUsd: 2n });
    expect(files.spacesWithPending).toHaveBeenCalledWith('o');
    expect(queue.enqueueSpace.mock.calls).toEqual([
      ['o', 's1', { debounce: false }],
      ['o', 's2', { debounce: false }],
    ]);
    await expect(spend.consumedMicroUsd('o')).resolves.toBe(42n);
    // A cut does not resume anything.
    await raised.run({ organizationId: 'o', fromMicroUsd: 2n, toMicroUsd: 1n });
    expect(queue.enqueueSpace).toHaveBeenCalledTimes(2);
    hooks.onModuleDestroy();
    await expect(spend.consumedMicroUsd('o')).resolves.toBe(0n);
  });
});
