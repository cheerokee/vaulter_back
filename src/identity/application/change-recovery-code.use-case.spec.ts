import { DomainValidationError } from '../../shared/domain/errors.js';
import type { UserRepository } from '../domain/user.repository.js';
import { User } from '../domain/user.js';
import { CurrentAuthProofVerifier } from './current-auth-proof-verifier.js';
import { ChangeRecoveryCodeUseCase } from './change-recovery-code.use-case.js';
import type { AuthProofHasher } from './ports/auth-proof-hasher.js';
import type { RecoveryProofHasher } from './ports/recovery-proof-hasher.js';

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
const NOW = new Date('2026-11-07T12:00:00Z');

const users = { findById: vi.fn(), save: vi.fn() };
const authHasher = {
  hash: vi.fn(),
  verify: vi.fn(),
  verifyAgainstDummy: vi.fn(),
};
const recoveryHasher = { hash: vi.fn() };
const useCase = new ChangeRecoveryCodeUseCase(
  users as unknown as UserRepository,
  recoveryHasher as unknown as RecoveryProofHasher,
  new CurrentAuthProofVerifier(
    users as unknown as UserRepository,
    authHasher as unknown as AuthProofHasher,
  ),
);
const auth = { userId: 'u1', sessionId: 's1' };

const input = () => ({
  currentAuthProof: b64(32, 1),
  newRecoveryProof: b64(32, 2),
  newRecoveryEncryptedPrivateKey: b64(73, 0x01),
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
    recoveryHash: 'old-recovery-hash',
    recoveryEncryptedPrivateKey: b64(73, 0x01),
    now: NOW,
  });
}

describe('ChangeRecoveryCodeUseCase', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    users.findById.mockImplementation(() => Promise.resolve(makeUser()));
    users.save.mockResolvedValue(undefined);
    authHasher.verify.mockResolvedValue(true);
    authHasher.verifyAgainstDummy.mockResolvedValue(false);
    recoveryHasher.hash.mockReturnValue('new-recovery-hash');
  });

  it('rejects a wrong current proof and saves nothing', async () => {
    authHasher.verify.mockResolvedValue(false);
    await expect(useCase.execute(auth, input())).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'current-auth-proof-invalid',
    });
    expect(users.save).not.toHaveBeenCalled();
    expect(recoveryHasher.hash).not.toHaveBeenCalled();
  });

  it('rejects malformed new material with a domain error and saves nothing', async () => {
    await expect(
      useCase.execute(auth, { ...input(), newRecoveryProof: 'short' }),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'recovery-proof-invalid',
    });
    await expect(
      useCase.execute(auth, {
        ...input(),
        newRecoveryEncryptedPrivateKey: 'short',
      }),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'recovery-encrypted-private-key-invalid',
    });
    expect(users.save).not.toHaveBeenCalled();
  });

  it('stores the hash of the new proof and the new blob', async () => {
    const data = input();
    await useCase.execute(auth, data);
    expect(recoveryHasher.hash).toHaveBeenCalledWith(data.newRecoveryProof);
    const saved: User = users.save.mock.calls[0][0];
    expect(saved.recoveryHash).toBe('new-recovery-hash');
    expect(saved.recoveryEncryptedPrivateKey).toBe(
      data.newRecoveryEncryptedPrivateKey,
    );
    expect(saved.authHash).toBe('old-hash');
  });
});
