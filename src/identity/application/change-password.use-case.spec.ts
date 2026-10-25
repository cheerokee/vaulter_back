import {
  DomainValidationError,
  UnauthenticatedError,
} from '../../shared/domain/errors.js';
import type { SessionRepository } from '../domain/session.repository.js';
import type { UserRepository } from '../domain/user.repository.js';
import { User } from '../domain/user.js';
import { ChangePasswordUseCase } from './change-password.use-case.js';
import type { AuthProofHasher } from './ports/auth-proof-hasher.js';

const b64 = (n: number, first?: number) => {
  const b = Buffer.alloc(n, 0xab);
  if (first !== undefined) b[0] = first;
  return b.toString('base64url');
};
const params = {
  algorithm: 'argon2id13',
  opsLimit: 3,
  memLimitBytes: 67108864,
};
const NOW = new Date('2026-10-24T12:00:00Z');

const users = { findById: vi.fn(), save: vi.fn() };
const sessions = { revokeAllForUser: vi.fn() };
const hasher = {
  hash: vi.fn(),
  verify: vi.fn(),
  verifyAgainstDummy: vi.fn(),
};
const useCase = new ChangePasswordUseCase(
  users as unknown as UserRepository,
  sessions as unknown as SessionRepository,
  hasher as unknown as AuthProofHasher,
);
const auth = { userId: 'u1', sessionId: 's1' };

const input = () => ({
  currentAuthProof: b64(32, 1),
  newAuthProof: b64(32, 2),
  newKdfSalt: b64(16, 9),
  newKdfParams: { ...params, opsLimit: 4 } as unknown,
  newEncryptedPrivateKey: b64(73, 0x01),
});

function makeUser(): User {
  return User.register({
    name: 'Ana',
    email: 'ana@x.com',
    authHash: 'old-hash',
    kdfSalt: b64(16),
    kdfParams: params,
    publicKey: b64(32),
    encryptedPrivateKey: b64(73, 0x01),
    now: NOW,
  });
}

describe('ChangePasswordUseCase', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    users.findById.mockImplementation(() => Promise.resolve(makeUser()));
    users.save.mockResolvedValue(undefined);
    sessions.revokeAllForUser.mockResolvedValue(undefined);
    hasher.verify.mockResolvedValue(true);
    hasher.hash.mockResolvedValue('new-hash');
    hasher.verifyAgainstDummy.mockResolvedValue(false);
  });
  afterEach(() => vi.useRealTimers());

  it('rejects a wrong current proof and changes nothing', async () => {
    hasher.verify.mockResolvedValue(false);
    await expect(useCase.execute(auth, input())).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'current-auth-proof-invalid',
    });
    expect(users.save).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('rejects a malformed current proof after a dummy verification', async () => {
    await expect(
      useCase.execute(auth, { ...input(), currentAuthProof: 'short' }),
    ).rejects.toMatchObject({ code: 'current-auth-proof-invalid' });
    expect(hasher.verifyAgainstDummy).toHaveBeenCalledOnce();
    expect(hasher.verify).not.toHaveBeenCalled();
    expect(users.save).not.toHaveBeenCalled();
  });

  it('stores the new hash and material and revokes the other sessions only', async () => {
    const data = input();
    await useCase.execute(auth, data);
    expect(hasher.verify).toHaveBeenCalledWith(
      'old-hash',
      data.currentAuthProof,
    );
    expect(hasher.hash).toHaveBeenCalledWith(data.newAuthProof);
    const saved: User = users.save.mock.calls[0][0];
    expect(saved.authHash).toBe('new-hash');
    expect(saved.kdfSalt).toBe(data.newKdfSalt);
    expect(saved.kdfParams).toEqual({ ...params, opsLimit: 4 });
    expect(saved.encryptedPrivateKey).toBe(data.newEncryptedPrivateKey);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
      'u1',
      'password_change',
      NOW,
      's1',
    );
  });

  it('validates the new material format before hashing', async () => {
    await expect(
      useCase.execute(auth, {
        ...input(),
        newKdfParams: { ...params, opsLimit: 99 },
      }),
    ).rejects.toMatchObject({ code: 'kdf-params-out-of-range' });
    await expect(
      useCase.execute(auth, { ...input(), newAuthProof: 'bad' }),
    ).rejects.toMatchObject({ code: 'auth-proof-invalid' });
    expect(hasher.hash).not.toHaveBeenCalled();
    expect(users.save).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('rejects a missing user as an invalid access token', async () => {
    users.findById.mockResolvedValue(null);
    await expect(useCase.execute(auth, input())).rejects.toMatchObject({
      constructor: UnauthenticatedError,
      code: 'invalid-access-token',
    });
  });
});
