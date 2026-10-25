import {
  MemberRemovedHooks,
  type MemberRemovedContext,
} from './member-removed-hooks.js';

const ctx: MemberRemovedContext = {
  organizationId: 'o1',
  userId: 'u1',
  actorId: 'a1',
  reason: 'removed',
  now: new Date('2026-10-25T00:00:00Z'),
};

describe('MemberRemovedHooks', () => {
  it('is a no-op with no hooks', async () => {
    await expect(new MemberRemovedHooks().run(ctx)).resolves.toBeUndefined();
  });

  it('runs hooks sequentially in registration order with the context', async () => {
    const hooks = new MemberRemovedHooks();
    const order: string[] = [];
    hooks.register({
      name: 'a',
      onMemberRemoved: async (c) => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(`a:${c.reason}`);
      },
    });
    hooks.register({
      name: 'b',
      onMemberRemoved: async (c) => {
        order.push(`b:${c.userId}`);
      },
    });
    await hooks.run(ctx);
    expect(order).toEqual(['a:removed', 'b:u1']);
  });

  it('propagates an error and skips the later hooks', async () => {
    const hooks = new MemberRemovedHooks();
    const later = vi.fn();
    hooks.register({
      name: 'a',
      onMemberRemoved: () => Promise.reject(new Error('boom')),
    });
    hooks.register({ name: 'b', onMemberRemoved: later });
    await expect(hooks.run(ctx)).rejects.toThrow('boom');
    expect(later).not.toHaveBeenCalled();
  });

  it('unregister stops the hook; duplicate names are rejected', async () => {
    const hooks = new MemberRemovedHooks();
    const fn = vi.fn();
    hooks.register({ name: 'a', onMemberRemoved: fn });
    expect(() => hooks.register({ name: 'a', onMemberRemoved: fn })).toThrow(
      /already registered/,
    );
    hooks.unregister('a');
    hooks.unregister('missing');
    await hooks.run(ctx);
    expect(fn).not.toHaveBeenCalled();
  });
});
