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
