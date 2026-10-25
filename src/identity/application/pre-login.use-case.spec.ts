import { DEFAULT_KDF_PARAMS } from '../domain/kdf-params.js';
import type { UserRepository } from '../domain/user.repository.js';
import { User } from '../domain/user.js';
import type { DecoySaltFactory } from './ports/decoy-salt-factory.js';
import { PreLoginUseCase } from './pre-login.use-case.js';

const b64 = (n: number, fill = 1) =>
  Buffer.alloc(n, fill).toString('base64url');

describe('PreLoginUseCase', () => {
  const users = { findByEmail: vi.fn() };
  const decoy = { saltFor: vi.fn() };
  const useCase = new PreLoginUseCase(
    users as unknown as UserRepository,
    decoy as unknown as DecoySaltFactory,
  );
  beforeEach(() => vi.resetAllMocks());

  it('returns the stored salt and params for an existing email, normalizing case', async () => {
    const epk = Buffer.alloc(73, 2);
    epk[0] = 1;
    const params = {
      algorithm: 'argon2id13' as const,
      opsLimit: 4,
      memLimitBytes: 134217728,
    };
    users.findByEmail.mockResolvedValue(
      User.register({
        name: 'Ana',
        email: 'ana@x.com',
        authHash: 'h',
        kdfSalt: b64(16, 7),
        kdfParams: params,
        publicKey: b64(32),
        encryptedPrivateKey: epk.toString('base64url'),
        now: new Date('2026-10-24T11:00:00Z'),
      }),
    );
    const out = await useCase.execute({ email: '  Ana@X.com ' });
    expect(users.findByEmail).toHaveBeenCalledWith('ana@x.com');
    expect(out).toEqual({ kdfSalt: b64(16, 7), kdfParams: params });
    expect(decoy.saltFor).not.toHaveBeenCalled();
  });

  it('returns the decoy salt and DEFAULT_KDF_PARAMS for unknown email', async () => {
    users.findByEmail.mockResolvedValue(null);
    decoy.saltFor.mockResolvedValue('decoy-salt');
    const out = await useCase.execute({ email: 'Nobody@X.com' });
    expect(decoy.saltFor).toHaveBeenCalledWith('nobody@x.com');
    expect(out).toEqual({
      kdfSalt: 'decoy-salt',
      kdfParams: DEFAULT_KDF_PARAMS,
    });
  });

  it('rejects a non-string email with a validation error, not a crash', async () => {
    await expect(
      useCase.execute({ email: undefined as unknown as string }),
    ).rejects.toMatchObject({ code: 'email-invalid' });
    expect(users.findByEmail).not.toHaveBeenCalled();
  });
});
