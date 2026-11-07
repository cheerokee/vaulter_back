import { Logger } from '@nestjs/common';
import {
  DomainValidationError,
  UnauthenticatedError,
} from '../../shared/domain/errors.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { SessionRepository } from '../domain/session.repository.js';
import type { UserRepository } from '../domain/user.repository.js';
import { User } from '../domain/user.js';
import { CompleteRecoveryUseCase } from './complete-recovery.use-case.js';
import type { AuthProofHasher } from './ports/auth-proof-hasher.js';
import type { RecoveryProofHasher } from './ports/recovery-proof-hasher.js';
import type { SessionIssuer } from './session-issuer.js';

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

function makeUser(): User {
  return User.register({
    name: 'Ana',
    email: 'ana@x.com',
    authHash: 'old-hash',
    kdfSalt: b64(16),
    kdfParams: params,
    publicKey: b64(32),
    encryptedPrivateKey: b64(73, 0x01),
    recoveryHash: 'stored-recovery-hash',
    recoveryEncryptedPrivateKey: b64(73, 0x01),
    now: NOW,
  });
}

const input = () => ({
  email: 'Ana@X.com',
  recoveryProof: b64(32, 7),
  newAuthProof: b64(32, 2),
  newKdfSalt: b64(16, 9),
  newKdfParams: { ...params, opsLimit: 4 } as unknown,
  newEncryptedPrivateKey: b64(73, 0x01),
  device: { name: 'Pixel', platform: 'android' as const },
  client: { ip: '203.0.113.1', userAgent: 'test' },
});

describe('CompleteRecoveryUseCase', () => {
  const users = { findByEmail: vi.fn(), save: vi.fn() };
  const sessions = { revokeAllForUser: vi.fn() };
  const authHasher = { hash: vi.fn() };
  const recoveryHasher = {
    hash: vi.fn(),
    verify: vi.fn(),
    verifyAgainstDummy: vi.fn(),
  };
  const issuer = { start: vi.fn() };
  const uow = { run: vi.fn() };
  const useCase = new CompleteRecoveryUseCase(
    users as unknown as UserRepository,
    sessions as unknown as SessionRepository,
    authHasher as unknown as AuthProofHasher,
    recoveryHasher as unknown as RecoveryProofHasher,
    issuer as unknown as SessionIssuer,
    uow as unknown as UnitOfWork,
  );
  const tokens = {
    sessionId: 's-new',
    accessToken: 'a',
    accessTokenExpiresAt: NOW,
    refreshToken: 'r',
    refreshTokenExpiresAt: NOW,
  };
  let user: User;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    user = makeUser();
    users.findByEmail.mockResolvedValue(user);
    users.save.mockResolvedValue(undefined);
    sessions.revokeAllForUser.mockResolvedValue(undefined);
    authHasher.hash.mockResolvedValue('new-hash');
    recoveryHasher.verify.mockReturnValue(true);
    issuer.start.mockResolvedValue(tokens);
    uow.run.mockImplementation((work: () => Promise<unknown>) => work());
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    logSpy.mockRestore();
  });

  it('rejects invalid new KDF params with a validation error before looking up the account', async () => {
    await expect(
      useCase.execute({ ...input(), newKdfParams: {} }),
    ).rejects.toBeInstanceOf(DomainValidationError);
    expect(users.findByEmail).not.toHaveBeenCalled();
    expect(recoveryHasher.verify).not.toHaveBeenCalled();
    expect(recoveryHasher.verifyAgainstDummy).not.toHaveBeenCalled();
  });

  it('rejects a malformed new auth proof or device before looking up the account', async () => {
    await expect(
      useCase.execute({ ...input(), newAuthProof: 'short' }),
    ).rejects.toBeInstanceOf(DomainValidationError);
    await expect(
      useCase.execute({
        ...input(),
        device: { name: 'Pixel', platform: 'toaster' as 'android' },
      }),
    ).rejects.toBeInstanceOf(DomainValidationError);
    expect(users.findByEmail).not.toHaveBeenCalled();
  });

  it('does not hash the new proof nor change anything when the recovery proof is wrong', async () => {
    recoveryHasher.verify.mockReturnValue(false);
    await expect(useCase.execute(input())).rejects.toMatchObject({
      constructor: UnauthenticatedError,
      code: 'recovery-failed',
    });
    expect(authHasher.hash).not.toHaveBeenCalled();
    expect(users.save).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(issuer.start).not.toHaveBeenCalled();
  });

  it('fails with recovery-failed for an unknown e-mail after a dummy verification', async () => {
    users.findByEmail.mockResolvedValue(null);
    const i = input();
    await expect(useCase.execute(i)).rejects.toMatchObject({
      code: 'recovery-failed',
    });
    expect(recoveryHasher.verifyAgainstDummy).toHaveBeenCalledWith(
      i.recoveryProof,
    );
    expect(authHasher.hash).not.toHaveBeenCalled();
  });

  it('changes the password, revokes every session and then starts a new one, in one unit of work', async () => {
    const i = input();
    const order: string[] = [];
    uow.run.mockImplementation(async (work: () => Promise<unknown>) => {
      order.push('run:start');
      const out = await work();
      order.push('run:end');
      return out;
    });
    users.save.mockImplementation(() => {
      order.push('save');
      return Promise.resolve();
    });
    sessions.revokeAllForUser.mockImplementation(() => {
      order.push('revoke');
      return Promise.resolve();
    });
    issuer.start.mockImplementation(() => {
      order.push('start');
      return Promise.resolve(tokens);
    });

    const out = await useCase.execute(i);

    expect(users.findByEmail).toHaveBeenCalledWith('ana@x.com');
    expect(recoveryHasher.verify).toHaveBeenCalledWith(
      'stored-recovery-hash',
      i.recoveryProof,
    );
    expect(authHasher.hash).toHaveBeenCalledWith(i.newAuthProof);
    expect(order).toEqual(['run:start', 'save', 'revoke', 'start', 'run:end']);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
      user.id,
      'account_recovery',
      NOW,
    );
    expect(sessions.revokeAllForUser.mock.calls[0]).toHaveLength(3);
    const saved = users.save.mock.calls[0]![0] as User;
    expect(saved.authHash).toBe('new-hash');
    expect(saved.kdfSalt).toBe(i.newKdfSalt);
    expect(saved.encryptedPrivateKey).toBe(i.newEncryptedPrivateKey);
    expect(saved.recoveryHash).toBe('stored-recovery-hash');
    expect(issuer.start).toHaveBeenCalledWith(user, i.device, i.client, NOW);
    expect(out.session).toBe(tokens);
    expect(out.keys.publicKey).toBe(user.publicKey);
    expect(out.keys.encryptedPrivateKey).toBe(i.newEncryptedPrivateKey);
    // Structured log after the unit of work, with nothing sensitive in it.
    expect(logSpy).toHaveBeenCalledWith({
      event: 'account.recovered',
      userId: user.id,
    });
  });
});
