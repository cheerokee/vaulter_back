import {
  SpaceMemberLeftHooks,
  type SpaceMemberLeftContext,
} from './space-member-left-hooks.js';

const ctx: SpaceMemberLeftContext = {
  organizationId: 'o1',
  spaceId: 's1',
  userId: 'u1',
  now: new Date('2026-11-01T00:00:00Z'),
};

describe('SpaceMemberLeftHooks', () => {
  it('is a no-op with no hooks', async () => {
    await expect(new SpaceMemberLeftHooks().run(ctx)).resolves.toBeUndefined();
  });

  it('runs hooks sequentially in registration order with the context', async () => {
    const hooks = new SpaceMemberLeftHooks();
    const order: string[] = [];
    hooks.register({
      name: 'a',
      onSpaceMemberLeft: async (c) => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(`a:${c.spaceId}`);
      },
    });
    hooks.register({
      name: 'b',
      onSpaceMemberLeft: async (c) => {
        order.push(`b:${c.userId}`);
      },
    });
    await hooks.run(ctx);
    expect(order).toEqual(['a:s1', 'b:u1']);
  });

  it('propagates an error and skips the later hooks', async () => {
    const hooks = new SpaceMemberLeftHooks();
    const later = vi.fn();
    hooks.register({
      name: 'a',
      onSpaceMemberLeft: () => Promise.reject(new Error('boom')),
    });
    hooks.register({ name: 'b', onSpaceMemberLeft: later });
    await expect(hooks.run(ctx)).rejects.toThrow('boom');
    expect(later).not.toHaveBeenCalled();
  });

  it('unregister stops the hook; duplicate names are rejected', async () => {
    const hooks = new SpaceMemberLeftHooks();
    const fn = vi.fn();
    hooks.register({ name: 'a', onSpaceMemberLeft: fn });
    expect(() => hooks.register({ name: 'a', onSpaceMemberLeft: fn })).toThrow(
      /already registered/,
    );
    hooks.unregister('a');
    hooks.unregister('missing');
    await hooks.run(ctx);
    expect(fn).not.toHaveBeenCalled();
  });
});
