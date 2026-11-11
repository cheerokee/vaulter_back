import { BackupObjectsChangedHooks } from './backup-objects-changed-hooks.js';

describe('BackupObjectsChangedHooks', () => {
  const ctx = {
    organizationId: 'o',
    spaceId: 's',
    objectIds: ['a'],
    change: 'committed' as const,
  };

  it('runs every hook in order; an error stops the rest', async () => {
    const hooks = new BackupObjectsChangedHooks();
    const calls: string[] = [];
    hooks.register({
      name: 'a',
      onBackupObjectsChanged: async () => {
        calls.push('a');
        throw new Error('a');
      },
    });
    hooks.register({
      name: 'b',
      onBackupObjectsChanged: async () => {
        calls.push('b');
      },
    });
    await expect(hooks.run(ctx)).rejects.toThrow('a');
    expect(calls).toEqual(['a']);
  });

  it('refuses a duplicate name, unregisters and skips empty changes', async () => {
    const hooks = new BackupObjectsChangedHooks();
    const fn = vi.fn(async () => undefined);
    hooks.register({ name: 'x', onBackupObjectsChanged: fn });
    expect(() =>
      hooks.register({ name: 'x', onBackupObjectsChanged: fn }),
    ).toThrow(/already registered/);
    await hooks.run({ ...ctx, objectIds: [] });
    expect(fn).not.toHaveBeenCalled();
    await hooks.run(ctx);
    expect(fn).toHaveBeenCalledTimes(1);
    hooks.unregister('x');
    await hooks.run(ctx);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
