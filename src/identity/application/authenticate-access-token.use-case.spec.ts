import { UnauthenticatedError } from '../../shared/domain/errors.js';
import type { SessionRepository } from '../domain/session.repository.js';
import { AuthenticateAccessTokenUseCase } from './authenticate-access-token.use-case.js';
import type { AccessTokenService } from './ports/access-token-service.js';
import { NOW, makeSession } from '../../../test/support/test-sessions.js';

describe('AuthenticateAccessTokenUseCase', () => {
  const tokens = { verify: vi.fn() };
  const sessions = { findById: vi.fn() };
  const useCase = new AuthenticateAccessTokenUseCase(
    tokens as unknown as AccessTokenService,
    sessions as unknown as SessionRepository,
  );
  const invalid = {
    constructor: UnauthenticatedError,
    code: 'invalid-access-token',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    tokens.verify.mockResolvedValue({ userId: 'u1', sessionId: 's1' });
    sessions.findById.mockResolvedValue(makeSession());
  });

  it('returns the actor for an active session', async () => {
    await expect(useCase.execute('t', NOW)).resolves.toEqual({
      userId: 'u1',
      sessionId: 's1',
    });
  });

  it('rejects a token whose session was revoked', async () => {
    sessions.findById.mockResolvedValue(makeSession({ revoked: true }));
    await expect(useCase.execute('t', NOW)).rejects.toMatchObject(invalid);
  });

  it('rejects a token whose session does not exist', async () => {
    sessions.findById.mockResolvedValue(null);
    await expect(useCase.execute('t', NOW)).rejects.toMatchObject(invalid);
  });

  it('rejects a token whose session expired', async () => {
    sessions.findById.mockResolvedValue(
      makeSession({ expiresAt: new Date('2026-10-24T11:00:00Z') }),
    );
    await expect(useCase.execute('t', NOW)).rejects.toMatchObject(invalid);
  });

  it('rejects a token whose sid belongs to another user', async () => {
    sessions.findById.mockResolvedValue(makeSession({ userId: 'other' }));
    await expect(useCase.execute('t', NOW)).rejects.toMatchObject(invalid);
  });

  it('propagates a verification failure', async () => {
    tokens.verify.mockRejectedValue(
      new UnauthenticatedError('invalid-access-token', 'x'),
    );
    await expect(useCase.execute('t', NOW)).rejects.toMatchObject(invalid);
    expect(sessions.findById).not.toHaveBeenCalled();
  });
});
