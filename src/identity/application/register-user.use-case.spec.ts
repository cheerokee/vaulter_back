import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import type { UserRepository } from '../domain/user.repository.js';
import type { User } from '../domain/user.js';
import type { AuthProofHasher } from './ports/auth-proof-hasher.js';
import { RegisterUserUseCase } from './register-user.use-case.js';
import type { SessionIssuer } from './session-issuer.js';

const b64 = (n: number, fill = 1) =>
  Buffer.alloc(n, fill).toString('base64url');
const epk = Buffer.alloc(73, 2);
epk[0] = 1;

const input = () => ({
  name: 'Ana',
  email: ' Ana@X.com ',
  authProof: b64(32, 9),
  kdfSalt: b64(16),
  kdfParams: { algorithm: 'argon2id13', opsLimit: 3, memLimitBytes: 67108864 },
  publicKey: b64(32),
  encryptedPrivateKey: epk.toString('base64url'),
  device: { name: 'Pixel', platform: 'android' as const },
  client: { ip: null, userAgent: null },
});

describe('RegisterUserUseCase', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const users = { create: vi.fn() };
  const hasher = { hash: vi.fn() };
  const issuer = { start: vi.fn() };
  const useCase = new RegisterUserUseCase(
    users as unknown as UserRepository,
    hasher as unknown as AuthProofHasher,
    issuer as unknown as SessionIssuer,
  );
  const tokens = {
    sessionId: 's',
    accessToken: 'a',
    accessTokenExpiresAt: now,
    refreshToken: 'r',
    refreshTokenExpiresAt: now,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    hasher.hash.mockResolvedValue('$argon2id$hashed');
    users.create.mockResolvedValue(undefined);
    issuer.start.mockResolvedValue(tokens);
  });
  afterEach(() => vi.useRealTimers());

  it('hashes the auth proof, never storing it raw, and starts a session', async () => {
    const i = input();
    const out = await useCase.execute(i);
    const created = users.create.mock.calls[0]![0] as User;
    expect(hasher.hash).toHaveBeenCalledWith(i.authProof);
    expect(created.authHash).toBe('$argon2id$hashed');
    expect(created.authHash).not.toBe(i.authProof);
    expect(created.email).toBe('ana@x.com');
    expect(issuer.start).toHaveBeenCalledWith(created, i.device, i.client, now);
    expect(out.keys).toEqual({
      publicKey: i.publicKey,
      encryptedPrivateKey: i.encryptedPrivateKey,
      kdfSalt: i.kdfSalt,
      kdfParams: i.kdfParams,
    });
    expect(out.session).toBe(tokens);
    expect(out.user).toMatchObject({ id: created.id, email: 'ana@x.com' });
  });

  it('rejects a malformed encryptedPrivateKey before touching the repository', async () => {
    await expect(
      useCase.execute({ ...input(), encryptedPrivateKey: b64(73, 2) }),
    ).rejects.toBeInstanceOf(DomainValidationError);
    expect(hasher.hash).not.toHaveBeenCalled();
    expect(users.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed authProof before hashing', async () => {
    await expect(
      useCase.execute({ ...input(), authProof: 'short' }),
    ).rejects.toMatchObject({ code: 'auth-proof-invalid' });
    expect(hasher.hash).not.toHaveBeenCalled();
    expect(users.create).not.toHaveBeenCalled();
  });

  it('propagates ConflictError for duplicate email', async () => {
    users.create.mockRejectedValue(
      new ConflictError('email-already-registered', 'dup'),
    );
    await expect(useCase.execute(input())).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(issuer.start).not.toHaveBeenCalled();
  });
});
