import { ServerKeyCopyCheck } from './server-key-copy-check.js';

describe('ServerKeyCopyCheck', () => {
  it('without a verifier a server copy is a programming error; one verifier at a time', async () => {
    const check = new ServerKeyCopyCheck();
    await expect(check.assertOpens('x')).rejects.toThrow(/no server key copy/);
    const assertOpens = vi.fn(async () => undefined);
    check.register({ name: 'a', assertOpens });
    expect(() => check.register({ name: 'b', assertOpens })).toThrow(
      /already registered/,
    );
    await check.assertOpens('copy');
    expect(assertOpens).toHaveBeenCalledWith('copy');
    check.unregister('a');
    await expect(check.assertOpens('x')).rejects.toThrow();
  });
});
