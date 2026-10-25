import { UnauthenticatedError } from '../../shared/domain/errors.js';
import type { UserRepository } from '../domain/user.repository.js';
import { User } from '../domain/user.js';
import { GetMeUseCase } from './get-me.use-case.js';

const users = { findById: vi.fn() };
const useCase = new GetMeUseCase(users as unknown as UserRepository);
const b64 = (n: number, first?: number) => {
  const b = Buffer.alloc(n, 0xab);
  if (first !== undefined) b[0] = first;
  return b.toString('base64url');
};

describe('GetMeUseCase', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns the user view without key material', async () => {
    const user = User.register({
      name: 'Ana',
      email: 'ana@x.com',
      authHash: '$argon2id$fake',
      kdfSalt: b64(16),
      kdfParams: {
        algorithm: 'argon2id13',
        opsLimit: 3,
        memLimitBytes: 67108864,
      },
      publicKey: b64(32),
      encryptedPrivateKey: b64(73, 0x01),
      now: new Date('2026-10-24T12:00:00Z'),
    });
    users.findById.mockResolvedValue(user);
    const view = await useCase.execute({ userId: user.id, sessionId: 's1' });
    expect(view).toEqual({
      id: user.id,
      name: 'Ana',
      email: 'ana@x.com',
      createdAt: new Date('2026-10-24T12:00:00Z'),
    });
  });

  it('rejects a missing user as an invalid access token', async () => {
    users.findById.mockResolvedValue(null);
    await expect(
      useCase.execute({ userId: 'u1', sessionId: 's1' }),
    ).rejects.toMatchObject({
      constructor: UnauthenticatedError,
      code: 'invalid-access-token',
    });
  });
});
