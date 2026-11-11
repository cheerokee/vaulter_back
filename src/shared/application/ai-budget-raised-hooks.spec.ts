import { AiBudgetRaisedHooks } from './ai-budget-raised-hooks.js';

describe('AiBudgetRaisedHooks', () => {
  const ctx = { organizationId: 'o', fromMicroUsd: 1n, toMicroUsd: 2n };

  it('runs every hook in order on a raise; an error stops the rest', async () => {
    const hooks = new AiBudgetRaisedHooks();
    const calls: string[] = [];
    hooks.register({
      name: 'a',
      onAiBudgetRaised: async () => {
        calls.push('a');
        throw new Error('a');
      },
    });
    hooks.register({
      name: 'b',
      onAiBudgetRaised: async () => {
        calls.push('b');
      },
    });
    await expect(hooks.run(ctx)).rejects.toThrow('a');
    expect(calls).toEqual(['a']);
  });

  it('does nothing when the budget did not go up; refuses duplicates; unregisters', async () => {
    const hooks = new AiBudgetRaisedHooks();
    const fn = vi.fn(async () => undefined);
    hooks.register({ name: 'x', onAiBudgetRaised: fn });
    expect(() => hooks.register({ name: 'x', onAiBudgetRaised: fn })).toThrow(
      /already registered/,
    );
    await hooks.run({ ...ctx, toMicroUsd: 1n });
    await hooks.run({ ...ctx, toMicroUsd: 0n });
    expect(fn).not.toHaveBeenCalled();
    await hooks.run(ctx);
    expect(fn).toHaveBeenCalledWith(ctx);
    hooks.unregister('x');
    await hooks.run(ctx);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
