import { UnauthenticatedError } from '../../shared/domain/errors.js';
import type { UserRepository } from '../domain/user.repository.js';
import { User } from '../domain/user.js';
import { LookupRecoveryUseCase } from './lookup-recovery.use-case.js';
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
const RECOVERY_BLOB = b64(73, 0x01);

function makeUser(): User {
  return User.register({
    name: 'Ana',
    email: 'ana@x.com',
    authHash: 'auth-hash',
    kdfSalt: b64(16),
    kdfParams: params,
    publicKey: b64(32),
    encryptedPrivateKey: b64(73, 0x01),
    recoveryHash: 'stored-recovery-hash',
    recoveryEncryptedPrivateKey: RECOVERY_BLOB,
    now: new Date('2026-11-07T12:00:00Z'),
  });
}

describe('LookupRecoveryUseCase', () => {
  const users = { findByEmail: vi.fn() };
  const recoveryHasher = {
    hash: vi.fn(),
    verify: vi.fn(),
    verifyAgainstDummy: vi.fn(),
  };
  const useCase = new LookupRecoveryUseCase(
    users as unknown as UserRepository,
    recoveryHasher as unknown as RecoveryProofHasher,
  );
  const proof = b64(32, 7);

  beforeEach(() => {
    vi.resetAllMocks();
    users.findByEmail.mockImplementation(() => Promise.resolve(makeUser()));
    recoveryHasher.verify.mockReturnValue(true);
  });

  it('returns the recovery copy of the private key for the right proof', async () => {
    const out = await useCase.execute({
      email: ' Ana@X.com ',
      recoveryProof: proof,
    });
    expect(out).toEqual({ recoveryEncryptedPrivateKey: RECOVERY_BLOB });
    expect(users.findByEmail).toHaveBeenCalledWith('ana@x.com');
    expect(recoveryHasher.verify).toHaveBeenCalledWith(
      'stored-recovery-hash',
      proof,
    );
    expect(recoveryHasher.verifyAgainstDummy).not.toHaveBeenCalled();
  });

  it('runs a dummy verification and fails with recovery-failed for an unknown e-mail', async () => {
    users.findByEmail.mockResolvedValue(null);
    await expect(
      useCase.execute({ email: 'nobody@x.com', recoveryProof: proof }),
    ).rejects.toMatchObject({
      constructor: UnauthenticatedError,
      code: 'recovery-failed',
      message: 'Invalid e-mail or recovery code.',
    });
    expect(recoveryHasher.verifyAgainstDummy).toHaveBeenCalledWith(proof);
    expect(recoveryHasher.verify).not.toHaveBeenCalled();
  });

  it('treats a wrong-size proof (42 chars) as recovery-failed, not a validation error', async () => {
    const short = 'A'.repeat(42);
    await expect(
      useCase.execute({ email: 'ana@x.com', recoveryProof: short }),
    ).rejects.toMatchObject({
      constructor: UnauthenticatedError,
      code: 'recovery-failed',
    });
    expect(recoveryHasher.verifyAgainstDummy).toHaveBeenCalledWith(short);
    expect(recoveryHasher.verify).not.toHaveBeenCalled();
  });

  it('fails with recovery-failed when the proof does not match', async () => {
    recoveryHasher.verify.mockReturnValue(false);
    await expect(
      useCase.execute({ email: 'ana@x.com', recoveryProof: proof }),
    ).rejects.toMatchObject({
      constructor: UnauthenticatedError,
      code: 'recovery-failed',
    });
  });

  it('takes the unknown-account path for a non-string e-mail', async () => {
    await expect(
      useCase.execute({
        email: 42 as unknown as string,
        recoveryProof: proof,
      }),
    ).rejects.toMatchObject({ code: 'recovery-failed' });
    expect(users.findByEmail).not.toHaveBeenCalled();
    expect(recoveryHasher.verifyAgainstDummy).toHaveBeenCalledWith(proof);
  });
});
