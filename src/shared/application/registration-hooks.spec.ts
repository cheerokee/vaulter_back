import {
  RegistrationHooks,
  type RegistrationHookContext,
} from './registration-hooks.js';

const ctx: RegistrationHookContext = {
  userId: 'u1',
  name: 'Ana',
  email: 'ana@x.com',
  inviteToken: 'tok',
  now: new Date('2026-10-25T00:00:00Z'),
};

describe('RegistrationHooks', () => {
  it('returns an empty result with no hooks', async () => {
    await expect(new RegistrationHooks().run(ctx)).resolves.toEqual({});
  });

  it('runs hooks sequentially in registration order with the context', async () => {
    const hooks = new RegistrationHooks();
    const order: string[] = [];
    hooks.register({
      name: 'a',
      onRegistered: async (c) => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(`a:${c.userId}`);
      },
    });
    hooks.register({
      name: 'b',
      onRegistered: async () => {
        order.push('b');
      },
    });
    await hooks.run(ctx);
    expect(order).toEqual(['a:u1', 'b']);
  });

  it('merges results shallowly', async () => {
    const hooks = new RegistrationHooks();
    hooks.register({ name: 'a', onRegistered: async () => undefined });
    hooks.register({
      name: 'b',
      onRegistered: async () => ({ invitation: { accepted: true } }),
    });
    await expect(hooks.run(ctx)).resolves.toEqual({
      invitation: { accepted: true },
    });
  });

  it('throws when two hooks set the same result key', async () => {
    const hooks = new RegistrationHooks();
    const r = async () => ({ invitation: { accepted: true } });
    hooks.register({ name: 'a', onRegistered: r });
    hooks.register({ name: 'b', onRegistered: r });
    await expect(hooks.run(ctx)).rejects.toThrow(/invitation.*b/);
  });

  it('propagates hook errors and stops', async () => {
    const hooks = new RegistrationHooks();
    const after = vi.fn();
    hooks.register({
      name: 'a',
      onRegistered: async () => {
        throw new Error('boom');
      },
    });
    hooks.register({ name: 'b', onRegistered: after });
    await expect(hooks.run(ctx)).rejects.toThrow('boom');
    expect(after).not.toHaveBeenCalled();
  });

  it('rejects duplicate names and supports unregister', async () => {
    const hooks = new RegistrationHooks();
    const hook = { name: 'a', onRegistered: vi.fn() };
    hooks.register(hook);
    expect(() => hooks.register(hook)).toThrow(/already/);
    hooks.unregister('a');
    await hooks.run(ctx);
    expect(hook.onRegistered).not.toHaveBeenCalled();
    hooks.register(hook);
  });
});
