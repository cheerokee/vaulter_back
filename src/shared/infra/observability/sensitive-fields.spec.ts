import { scrubSensitive, SENSITIVE_KEYS } from './sensitive-fields.js';

describe('scrubSensitive', () => {
  it('redacts nested sensitive keys case-insensitively without mutating', () => {
    const input = {
      a: { authProof: 'x', keep: 1, list: [{ encrypted_private_key: 'k' }] },
      Authorization: 'Bearer abc',
      name: 'ana',
    };
    const copy = structuredClone(input);
    const out = scrubSensitive(input);
    expect(out.a.authProof).toBe('[REDACTED]');
    expect(out.a.list[0]).toEqual({ encrypted_private_key: '[REDACTED]' });
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.a.keep).toBe(1);
    expect(out.name).toBe('ana');
    expect(input).toEqual(copy);
  });

  it('lists both spellings', () => {
    expect(SENSITIVE_KEYS).toEqual(
      expect.arrayContaining([
        'wrappedKey',
        'wrapped_key',
        'refresh_token',
        'kdfSalt',
        'kdf_params',
        'password',
        'set-cookie',
      ]),
    );
  });
});

describe('scrubSensitive with errors and class instances', () => {
  it('keeps name, message and stack of an Error and scrubs own props', () => {
    const err = Object.assign(new Error('boom'), {
      response: { wrappedKey: 'S' },
    });
    const out = scrubSensitive({ err }) as any;
    expect(out.err.message).toBe('boom');
    expect(out.err.name).toBe('Error');
    expect(out.err.stack).toContain('boom');
    expect(out.err.response.wrappedKey).toBe('[REDACTED]');
  });

  it('passes non-plain objects through untouched', () => {
    class Sock {
      authProof = 'x';
    }
    const s = new Sock();
    expect((scrubSensitive({ s }) as any).s).toBe(s);
  });
});
