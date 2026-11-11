import { EventEmitter } from 'node:events';
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
        'refreshTokenHash',
        'refresh_token_hash',
        'secret',
        'token',
        'inviteToken',
        'invite_token',
        'recoveryWrappedKey',
        'recovery_wrapped_key',
        'serverWrappedKey',
        'server_wrapped_key',
        'hubWrappedKey',
        'hub_wrapped_key',
      ]),
    );
    expect(
      scrubSensitive({ recoveryWrappedKey: 'k', recovery_wrapped_key: 'k' }),
    ).toEqual({
      recoveryWrappedKey: '[REDACTED]',
      recovery_wrapped_key: '[REDACTED]',
    });
    expect(scrubSensitive({ inviteToken: 't', invite_token: 't' })).toEqual({
      inviteToken: '[REDACTED]',
      invite_token: '[REDACTED]',
    });
  });

  it('redacts the account recovery fields in both spellings', () => {
    const keys = [
      'recoveryProof',
      'recovery_proof',
      'newRecoveryProof',
      'new_recovery_proof',
      'recoveryEncryptedPrivateKey',
      'recovery_encrypted_private_key',
      'newRecoveryEncryptedPrivateKey',
      'new_recovery_encrypted_private_key',
      'recoveryHash',
      'recovery_hash',
    ];
    expect(SENSITIVE_KEYS).toEqual(expect.arrayContaining(keys));
    const input = Object.fromEntries(keys.map((k) => [k, 'secret-value']));
    expect(scrubSensitive({ body: input })).toEqual({
      body: Object.fromEntries(keys.map((k) => [k, '[REDACTED]'])),
    });
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

  it('scrubs class instances such as DTOs', () => {
    class Dto {
      authProof = 'x';
      email = 'a@b.c';
    }
    class Wrapper {
      inner = new Dto();
    }
    const out = scrubSensitive({ dto: new Dto(), w: new Wrapper() }) as any;
    expect(out.dto).toEqual({ authProof: '[REDACTED]', email: 'a@b.c' });
    expect(out.w.inner.authProof).toBe('[REDACTED]');
  });

  it('scrubs Map keys and walks Set values', () => {
    const out = scrubSensitive({
      m: new Map<string, unknown>([
        ['refreshToken', 'r'],
        ['ok', { kdfSalt: 's' }],
      ]),
      s: new Set([{ wrappedKey: 'w' }]),
    }) as any;
    expect(out.m.refreshToken).toBe('[REDACTED]');
    expect(out.m.ok.kdfSalt).toBe('[REDACTED]');
    expect(out.s[0].wrappedKey).toBe('[REDACTED]');
  });

  it('returns EventEmitters as-is without touching getters', () => {
    let touched = false;
    class Emitter extends EventEmitter {
      authProof = 'x';
      get socket() {
        touched = true;
        return {};
      }
    }
    const e = new Emitter();
    const out = scrubSensitive({ e }) as any;
    expect(out.e).toBe(e);
    expect(touched).toBe(false);
  });
});
