import { SpaceKeyRotatedHooks } from './space-key-rotated-hooks.js';

describe('SpaceKeyRotatedHooks', () => {
  const ctx = {
    organizationId: 'o',
    spaceId: 's',
    spaceKeyId: 'k',
    version: 2,
    serverWrappedKey: null,
    actorUserId: 'u',
  };

  it('runs every hook in order; an error stops the rest', async () => {
    const hooks = new SpaceKeyRotatedHooks();
    const calls: string[] = [];
    hooks.register({
      name: 'a',
      onSpaceKeyRotated: async () => {
        calls.push('a');
        throw new Error('a');
      },
    });
    hooks.register({
      name: 'b',
      onSpaceKeyRotated: async () => {
        calls.push('b');
      },
    });
    await expect(hooks.run(ctx)).rejects.toThrow('a');
    expect(calls).toEqual(['a']);
  });

  it('refuses a duplicate name and unregisters', async () => {
    const hooks = new SpaceKeyRotatedHooks();
    const fn = vi.fn(async () => undefined);
    hooks.register({ name: 'x', onSpaceKeyRotated: fn });
    expect(() => hooks.register({ name: 'x', onSpaceKeyRotated: fn })).toThrow(
      /already registered/,
    );
    hooks.unregister('x');
    await hooks.run(ctx);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a server copy with no hook registered is a programming error (never dropped silently)', async () => {
    const hooks = new SpaceKeyRotatedHooks();
    await expect(
      hooks.run({ ...ctx, serverWrappedKey: 'x'.repeat(108) }),
    ).rejects.toThrow(/no space-key-rotated hook/);
  });
});
