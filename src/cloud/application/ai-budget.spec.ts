import type { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import {
  AiBudgetExceededError,
  type AiBudgetMonth,
} from '../domain/ai-usage.js';
import type { AiUsageLedger } from '../domain/ai-usage.repository.js';
import { AiBudget } from './ai-budget.js';

const ORG = '0195f3a2-0000-7000-8000-000000000001';
const SPACE = '0195f3a2-0000-7000-8000-000000000002';
const RESETS = new Date('2026-12-01T00:00:00Z');

function setup(budget: bigint | null, spent = 0n, reserved = 0n) {
  const trace: string[] = [];
  let inTx = false;
  const directory = {
    lockAiBudget: vi.fn(async () => {
      trace.push(`lockAiBudget${inTx ? '' : '@out'}`);
      return budget;
    }),
  };
  const month: AiBudgetMonth = {
    month: '2026-11-01',
    resetsAt: RESETS,
    spentMicroUsd: spent,
    reservedMicroUsd: reserved,
  };
  const ledger = {
    expireStale: vi.fn(async () => {
      trace.push('expireStale');
      return 0;
    }),
    currentMonth: vi.fn(async () => {
      trace.push('currentMonth');
      return month;
    }),
    insertReservation: vi.fn(async () => {
      trace.push('insertReservation');
    }),
    settle: vi.fn(async () => true),
    release: vi.fn(async () => true),
    extend: vi.fn(async () => true),
  };
  const uow = {
    isActive: vi.fn(() => inTx),
    run: vi.fn(async (fn: () => Promise<unknown>) => {
      inTx = true;
      trace.push('run');
      try {
        return await fn();
      } finally {
        trace.push('commit');
        inTx = false;
      }
    }),
  };
  const budgetSvc = new AiBudget(
    directory as unknown as OrganizationDirectory,
    ledger as unknown as AiUsageLedger,
    uow as unknown as UnitOfWork,
  );
  return { budget: budgetSvc, trace, ledger, uow };
}

const req = (estimatedMicroUsd: bigint) => ({
  organizationId: ORG,
  spaceId: SPACE,
  kind: 'answer' as const,
  estimatedMicroUsd,
});

describe('AiBudget', () => {
  it('reserves in one short transaction: organization lock, stale reservations expired, month read, insert', async () => {
    const k = setup(1000n, 400n, 100n);
    const r = await k.budget.reserve(req(500n));
    expect(r).toMatchObject({
      organizationId: ORG,
      spaceId: SPACE,
      kind: 'answer',
      month: '2026-11-01',
      amountMicroUsd: 500n,
    });
    expect(k.trace).toEqual([
      'run',
      'lockAiBudget',
      'expireStale',
      'currentMonth',
      'insertReservation',
      'commit',
    ]);
    expect(k.ledger.insertReservation).toHaveBeenCalledWith(r, 15 * 60);
  });

  it('spent + reserved + estimate beyond the budget: 422 ai-budget-exceeded with resetsAt, nothing inserted', async () => {
    const k = setup(1000n, 400n, 100n);
    const err = await k.budget.reserve(req(501n)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBudgetExceededError);
    expect(err).toMatchObject({
      code: 'ai-budget-exceeded',
      details: { resetsAt: RESETS.toISOString() },
    });
    expect(k.ledger.insertReservation).not.toHaveBeenCalled();
  });

  it('a budget of 0 or an unknown organization refuses even a free call', async () => {
    await expect(setup(0n).budget.reserve(req(0n))).rejects.toBeInstanceOf(
      AiBudgetExceededError,
    );
    await expect(setup(null).budget.reserve(req(0n))).rejects.toBeInstanceOf(
      AiBudgetExceededError,
    );
  });

  it('tryReserve runs onRefused inside the refusing transaction (still under the organization lock)', async () => {
    const k = setup(10n, 10n);
    const onRefused = vi.fn(async () => {
      k.trace.push('onRefused');
    });
    await expect(k.budget.tryReserve(req(1n), onRefused)).resolves.toEqual({
      refusal: { resetsAt: RESETS },
    });
    expect(k.trace).toEqual([
      'run',
      'lockAiBudget',
      'expireStale',
      'currentMonth',
      'onRefused',
      'commit',
    ]);
  });

  it('refuses to run inside an open unit of work (it would hold the organization lock until the caller commits)', async () => {
    const k = setup(1000n);
    k.uow.isActive.mockReturnValueOnce(true);
    await expect(k.budget.reserve(req(1n))).rejects.toThrow(
      /outside a unit of work/,
    );
    await expect(k.budget.reserve(req(-1n))).rejects.toThrow(/non-negative/);
  });

  it('settle (in a transaction) and release go to the ledger by the reservation id', async () => {
    const k = setup(1000n);
    const r = await k.budget.reserve(req(10n));
    const spend = {
      model: 'm',
      inputTokens: 1,
      outputTokens: 2,
      costMicroUsd: 12n,
    };
    await k.budget.settle(r, spend);
    expect(k.ledger.settle).toHaveBeenCalledWith(ORG, r.id, spend);
    expect(k.uow.run).toHaveBeenCalledTimes(2);
    await k.budget.release(r);
    expect(k.ledger.release).toHaveBeenCalledWith(ORG, r.id);
    await k.budget.keepAlive(r);
    expect(k.ledger.extend).toHaveBeenCalledWith(ORG, r.id, 15 * 60);
  });
});
