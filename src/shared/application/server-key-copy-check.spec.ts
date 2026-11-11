import { ServerKeyCopyCheck } from './server-key-copy-check.js';

describe('ServerKeyCopyCheck', () => {
  it('without a verifier a server copy is a programming error; one verifier at a time', async () => {
    const check = new ServerKeyCopyCheck();
    await expect(check.assertOpens('x')).rejects.toThrow(/no server key copy/);
    await check.prepare(); // no verifier: nothing to prepare
    const assertOpens = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => undefined);
    check.register({ name: 'a', assertOpens, prepare });
    expect(() => check.register({ name: 'b', assertOpens, prepare })).toThrow(
      /already registered/,
    );
    await check.assertOpens('copy');
    expect(assertOpens).toHaveBeenCalledWith('copy');
    await check.prepare();
    expect(prepare).toHaveBeenCalledTimes(1);
    check.unregister('a');
    await expect(check.assertOpens('x')).rejects.toThrow();
  });
});
