import {
  HubExecutorLostHooks,
  type HubExecutorLostContext,
} from './hub-executor-lost-hooks.js';

const ctx: HubExecutorLostContext = {
  hubId: 'h1',
  organizationId: 'o1',
  spaceId: null,
  reason: 'hub_deregistered',
  actorId: 'u1',
  now: new Date('2026-11-09T00:00:00Z'),
};

describe('HubExecutorLostHooks', () => {
  it('is a no-op with no hooks', async () => {
    await expect(new HubExecutorLostHooks().run(ctx)).resolves.toBeUndefined();
  });

  it('runs hooks sequentially, lower `order` first, ties in registration order', async () => {
    const hooks = new HubExecutorLostHooks();
    const order: string[] = [];
    const hook = (name: string, o?: number) => ({
      name,
      ...(o === undefined ? {} : { order: o }),
      onExecutorLost: async (c: HubExecutorLostContext) => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(`${name}:${c.reason}`);
      },
    });
    hooks.register(hook('a'));
    hooks.register(hook('b'));
    hooks.register(hook('first', -1));
    await hooks.run(ctx);
    expect(order).toEqual([
      'first:hub_deregistered',
      'a:hub_deregistered',
      'b:hub_deregistered',
    ]);
  });

  it('propagates an error and skips the later hooks', async () => {
    const hooks = new HubExecutorLostHooks();
    const later = vi.fn();
    hooks.register({
      name: 'a',
      onExecutorLost: () => Promise.reject(new Error('boom')),
    });
    hooks.register({ name: 'b', onExecutorLost: later });
    await expect(hooks.run(ctx)).rejects.toThrow('boom');
    expect(later).not.toHaveBeenCalled();
  });

  it('unregister stops the hook; duplicate names are rejected', async () => {
    const hooks = new HubExecutorLostHooks();
    const fn = vi.fn();
    hooks.register({ name: 'a', onExecutorLost: fn });
    expect(() => hooks.register({ name: 'a', onExecutorLost: fn })).toThrow(
      /already registered/,
    );
    hooks.unregister('a');
    hooks.unregister('missing');
    await hooks.run(ctx);
    expect(fn).not.toHaveBeenCalled();
  });
});
