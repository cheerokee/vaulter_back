import { StorageReconcileHooks } from './storage-reconcile-hooks.js';

describe('StorageReconcileHooks', () => {
  it('is empty with no hooks', async () => {
    await expect(new StorageReconcileHooks().run(60)).resolves.toEqual({});
  });

  it('runs hooks sequentially with the age and keys the results by name', async () => {
    const hooks = new StorageReconcileHooks();
    const order: string[] = [];
    hooks.register({
      name: 'a',
      reconcile: async (age) => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(`a:${age}`);
        return { rows: 1 };
      },
    });
    hooks.register({
      name: 'b',
      reconcile: async (age) => {
        order.push(`b:${age}`);
        return { rows: 2 };
      },
    });
    expect(await hooks.run(30)).toEqual({ a: { rows: 1 }, b: { rows: 2 } });
    expect(order).toEqual(['a:30', 'b:30']);
  });

  it('refuses a duplicate name; unregister removes it; an error goes up', async () => {
    const hooks = new StorageReconcileHooks();
    const hook = {
      name: 'x',
      reconcile: async () => {
        throw new Error('boom');
      },
    };
    hooks.register(hook);
    expect(() => hooks.register(hook)).toThrow(/already registered/);
    await expect(hooks.run(60)).rejects.toThrow('boom');
    hooks.unregister('x');
    await expect(hooks.run(60)).resolves.toEqual({});
  });
});
