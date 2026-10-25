import { UnauthenticatedError } from '../../shared/domain/errors.js';
import type { UserRepository } from '../domain/user.repository.js';
import { User } from '../domain/user.js';
import { LoginUseCase } from './login.use-case.js';
import type { AuthProofHasher } from './ports/auth-proof-hasher.js';
import type { SessionIssuer } from './session-issuer.js';

const b64 = (n: number, fill = 1) =>
  Buffer.alloc(n, fill).toString('base64url');
const epk = Buffer.alloc(73, 2);
epk[0] = 1;
const PROOF = b64(32, 9);

const user = User.register({
  name: 'Ana',
  email: 'ana@x.com',
  authHash: 'stored-hash',
  kdfSalt: b64(16),
  kdfParams: { algorithm: 'argon2id13', opsLimit: 3, memLimitBytes: 67108864 },
  publicKey: b64(32),
  encryptedPrivateKey: epk.toString('base64url'),
  now: new Date('2026-10-24T11:00:00Z'),
});
const device = { name: 'Pixel', platform: 'android' as const };
const client = { ip: null, userAgent: null };

describe('LoginUseCase', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const users = { findByEmail: vi.fn() };
  const hasher = { verify: vi.fn(), verifyAgainstDummy: vi.fn() };
  const issuer = { start: vi.fn() };
  const useCase = new LoginUseCase(
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
    users.findByEmail.mockResolvedValue(user);
    hasher.verifyAgainstDummy.mockResolvedValue(false);
    issuer.start.mockResolvedValue(tokens);
  });
  afterEach(() => vi.useRealTimers());

  const invalid = {
    constructor: UnauthenticatedError,
    code: 'invalid-credentials',
  };

  it('returns user, keys and session for the right proof', async () => {
    hasher.verify.mockResolvedValue(true);
    const out = await useCase.execute({
      email: ' Ana@X.com',
      authProof: PROOF,
      device,
      client,
    });
    expect(users.findByEmail).toHaveBeenCalledWith('ana@x.com');
    expect(hasher.verify).toHaveBeenCalledWith('stored-hash', PROOF);
    expect(issuer.start).toHaveBeenCalledWith(user, device, client, now);
    expect(out.user.email).toBe('ana@x.com');
    expect(out.keys.publicKey).toBe(user.publicKey);
    expect(out.keys.encryptedPrivateKey).toBe(user.encryptedPrivateKey);
    expect(out.session).toBe(tokens);
  });

  it('throws invalid-credentials for wrong proof', async () => {
    hasher.verify.mockResolvedValue(false);
    await expect(
      useCase.execute({ email: 'ana@x.com', authProof: PROOF, device, client }),
    ).rejects.toMatchObject(invalid);
    expect(issuer.start).not.toHaveBeenCalled();
  });

  it('throws the same invalid-credentials for unknown email and still runs verifyAgainstDummy', async () => {
    users.findByEmail.mockResolvedValue(null);
    await expect(
      useCase.execute({ email: 'no@x.com', authProof: PROOF, device, client }),
    ).rejects.toMatchObject(invalid);
    expect(hasher.verifyAgainstDummy).toHaveBeenCalledWith(PROOF);
    expect(hasher.verify).not.toHaveBeenCalled();
  });

  it('rejects a malformed authProof with invalid-credentials, not 422', async () => {
    for (const authProof of ['short', b64(33), `${PROOF}=`, '']) {
      await expect(
        useCase.execute({ email: 'ana@x.com', authProof, device, client }),
      ).rejects.toMatchObject(invalid);
    }
    expect(hasher.verifyAgainstDummy).toHaveBeenCalledTimes(4);
    expect(hasher.verify).not.toHaveBeenCalled();
    expect(issuer.start).not.toHaveBeenCalled();
  });

  it('failure paths are indistinguishable: same constructor, code and message', async () => {
    const run = async (
      email: unknown,
      authProof: string,
    ): Promise<UnauthenticatedError> => {
      try {
        await useCase.execute({
          email: email as string,
          authProof,
          device,
          client,
        });
      } catch (e) {
        return e as UnauthenticatedError;
      }
      throw new Error('expected a failure');
    };
    users.findByEmail.mockImplementation((e: string) =>
      Promise.resolve(e === 'ana@x.com' ? user : null),
    );
    hasher.verify.mockResolvedValue(false);
    const unknown = await run('no@x.com', PROOF);
    const malformed = await run('ana@x.com', 'short');
    const wrong = await run('ana@x.com', PROOF);
    const nonString = await run(undefined, PROOF);
    for (const e of [malformed, wrong, nonString]) {
      expect(e.constructor).toBe(unknown.constructor);
      expect(e.code).toBe(unknown.code);
      expect(e.message).toBe(unknown.message);
    }
    expect(unknown.code).toBe('invalid-credentials');
    expect(hasher.verifyAgainstDummy).toHaveBeenCalledTimes(3);
  });
});
