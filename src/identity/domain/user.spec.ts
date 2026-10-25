import { DomainValidationError } from '../../shared/domain/errors.js';
import { isUuidV7 } from '../../shared/domain/id.js';
import { DEFAULT_KDF_PARAMS } from './kdf-params.js';
import { User } from './user.js';

const b64 = (n: number, fill = 0x11) =>
  Buffer.alloc(n, fill).toString('base64url');
const epk = (fill = 0x22) => {
  const b = Buffer.alloc(73, fill);
  b[0] = 1;
  return b.toString('base64url');
};

const input = () => ({
  name: '  Ana  ',
  email: ' Ana@X.COM ',
  authHash: 'hash',
  kdfSalt: b64(16),
  kdfParams: { ...DEFAULT_KDF_PARAMS },
  publicKey: b64(32),
  encryptedPrivateKey: epk(),
  now: new Date('2026-10-24T12:00:00Z'),
});

describe('User', () => {
  it('register normalizes and generates a v7 id', () => {
    const u = User.register(input());
    expect(isUuidV7(u.id)).toBe(true);
    expect(u.email).toBe('ana@x.com');
    expect(u.name).toBe('Ana');
    expect(u.createdAt).toEqual(new Date('2026-10-24T12:00:00Z'));
    expect(u.authHash).toBe('hash');
    expect(u.kdfParams).toEqual(DEFAULT_KDF_PARAMS);
  });

  it('rejects blank, empty and too long names', () => {
    for (const name of ['   ', '', 'a'.repeat(256)]) {
      expect(() => User.register({ ...input(), name })).toThrowError(
        expect.objectContaining({ code: 'user-name-invalid' }),
      );
    }
    expect(
      User.register({ ...input(), name: 'a'.repeat(255) }).name,
    ).toHaveLength(255);
  });

  it('validates material on register', () => {
    expect(() => User.register({ ...input(), kdfSalt: 'x' })).toThrow(
      DomainValidationError,
    );
    expect(() => User.register({ ...input(), publicKey: 'x' })).toThrow(
      DomainValidationError,
    );
    expect(() =>
      User.register({ ...input(), encryptedPrivateKey: 'x' }),
    ).toThrow(DomainValidationError);
    expect(() => User.register({ ...input(), kdfParams: null })).toThrow(
      DomainValidationError,
    );
    expect(() => User.register({ ...input(), authHash: '' })).toThrow(
      DomainValidationError,
    );
  });

  it('changePassword swaps the 4 fields and keeps publicKey', () => {
    const u = User.register(input());
    const pk = u.publicKey;
    const salt = b64(16, 0x33);
    const enc = epk(0x44);
    u.changePassword({
      authHash: 'new',
      kdfSalt: salt,
      kdfParams: {
        algorithm: 'argon2id13',
        opsLimit: 4,
        memLimitBytes: 134217728,
      },
      encryptedPrivateKey: enc,
    });
    expect(u.authHash).toBe('new');
    expect(u.kdfSalt).toBe(salt);
    expect(u.kdfParams.opsLimit).toBe(4);
    expect(u.encryptedPrivateKey).toBe(enc);
    expect(u.publicKey).toBe(pk);
  });

  it('changePassword validates', () => {
    const u = User.register(input());
    expect(() =>
      u.changePassword({
        authHash: 'new',
        kdfSalt: 'bad',
        kdfParams: { ...DEFAULT_KDF_PARAMS },
        encryptedPrivateKey: epk(),
      }),
    ).toThrow(DomainValidationError);
    expect(u.authHash).toBe('hash');
  });

  it('restore keeps the id', () => {
    const u = User.register(input());
    const props = {
      name: u.name,
      email: u.email,
      authHash: u.authHash,
      kdfSalt: u.kdfSalt,
      kdfParams: u.kdfParams,
      publicKey: u.publicKey,
      encryptedPrivateKey: u.encryptedPrivateKey,
    };
    expect(User.restore(props, 'some-id').id).toBe('some-id');
  });
});
