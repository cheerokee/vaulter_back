import { SpaceQuotaHooks } from './space-quota-hooks.js';

describe('SpaceQuotaHooks', () => {
  const ctx = { organizationId: 'o', spaceId: 's' };
  const increase = { ...ctx, actorUserId: 'u', fromBytes: 1, toBytes: 2 };

  it('runs every hook in registration order; an error stops the rest', async () => {
    const hooks = new SpaceQuotaHooks();
    const calls: string[] = [];
    const hook = (name: string, fail = false) => ({
      name,
      lock: async () => {
        calls.push(`${name}.lock`);
      },
      assertIncrease: async () => {
        calls.push(`${name}.assert`);
        if (fail) throw new Error(name);
      },
    });
    hooks.register(hook('a', true));
    hooks.register(hook('b'));
    await hooks.lock(ctx);
    await expect(hooks.assertIncrease(increase)).rejects.toThrow('a');
    expect(calls).toEqual(['a.lock', 'b.lock', 'a.assert']);
  });

  it('refuses a duplicate name and unregisters', async () => {
    const hooks = new SpaceQuotaHooks();
    const lock = vi.fn(async () => undefined);
    const h = { name: 'x', lock, assertIncrease: vi.fn() };
    hooks.register(h);
    expect(() => hooks.register(h)).toThrow(/already registered/);
    hooks.unregister('x');
    await hooks.lock(ctx);
    expect(lock).not.toHaveBeenCalled();
  });
});
