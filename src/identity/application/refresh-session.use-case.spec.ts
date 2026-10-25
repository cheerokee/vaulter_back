import type { ConfigService } from '@nestjs/config';
import { UnauthenticatedError } from '../../shared/domain/errors.js';
import type { SessionRepository } from '../domain/session.repository.js';
import type { AccessTokenService } from './ports/access-token-service.js';
import type { RefreshTokenCodec } from './ports/refresh-token-codec.js';
import { RefreshSessionUseCase } from './refresh-session.use-case.js';
import { NOW, hexHash, makeSession } from './test-sessions.js';

describe('RefreshSessionUseCase', () => {
  const sessions = {
    findById: vi.fn(),
    rotateRefreshToken: vi.fn(),
    save: vi.fn(),
  };
  const codec = { parse: vi.fn(), generate: vi.fn() };
  const access = { issue: vi.fn() };
  const config = { getOrThrow: vi.fn() };
  const useCase = new RefreshSessionUseCase(
    sessions as unknown as SessionRepository,
    codec as unknown as RefreshTokenCodec,
    access as unknown as AccessTokenService,
    config as unknown as ConfigService,
  );
  const client = { ip: '9.9.9.9', userAgent: 'ua' };
  const invalid = {
    constructor: UnauthenticatedError,
    code: 'invalid-refresh-token',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    config.getOrThrow.mockReturnValue('30');
    codec.parse.mockReturnValue({ sessionId: 's1', hash: hexHash(1) });
    codec.generate.mockResolvedValue({ token: 's1.new', hash: hexHash(2) });
    sessions.findById.mockImplementation(() => Promise.resolve(makeSession()));
    sessions.rotateRefreshToken.mockResolvedValue(true);
    sessions.save.mockResolvedValue(undefined);
    access.issue.mockResolvedValue({
      token: 'at',
      expiresAt: new Date('2026-10-24T12:15:00Z'),
    });
  });
  afterEach(() => vi.useRealTimers());

  it('rotates the refresh token and issues a new access token', async () => {
    const result = await useCase.execute({ refreshToken: 'x', client });
    expect(result).toEqual({
      sessionId: 's1',
      accessToken: 'at',
      accessTokenExpiresAt: new Date('2026-10-24T12:15:00Z'),
      refreshToken: 's1.new',
      refreshTokenExpiresAt: new Date('2026-11-23T12:00:00Z'),
    });
    const [rotated, expected] = sessions.rotateRefreshToken.mock.calls[0];
    expect(rotated.refreshTokenHash).toBe(hexHash(2));
    expect(rotated.lastIp).toBe('9.9.9.9');
    expect(expected).toBe(hexHash(1));
    expect(sessions.save).not.toHaveBeenCalled();
  });

  it('rejects a malformed token', async () => {
    codec.parse.mockReturnValue(null);
    await expect(
      useCase.execute({ refreshToken: 'x', client }),
    ).rejects.toMatchObject(invalid);
    expect(sessions.findById).not.toHaveBeenCalled();
  });

  it('rejects an unknown session', async () => {
    sessions.findById.mockResolvedValue(null);
    await expect(
      useCase.execute({ refreshToken: 'x', client }),
    ).rejects.toMatchObject(invalid);
  });

  it('rejects an expired session without writing a revocation', async () => {
    sessions.findById.mockResolvedValue(
      makeSession({ expiresAt: new Date('2026-10-24T11:00:00Z') }),
    );
    await expect(
      useCase.execute({ refreshToken: 'x', client }),
    ).rejects.toMatchObject(invalid);
    expect(sessions.save).not.toHaveBeenCalled();
    expect(sessions.rotateRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects a revoked session without writing', async () => {
    sessions.findById.mockResolvedValue(makeSession({ revoked: true }));
    await expect(
      useCase.execute({ refreshToken: 'x', client }),
    ).rejects.toMatchObject(invalid);
    expect(sessions.save).not.toHaveBeenCalled();
  });

  it('revokes the session with refresh_reuse when an old refresh token is presented', async () => {
    codec.parse.mockReturnValue({ sessionId: 's1', hash: hexHash(7) });
    await expect(
      useCase.execute({ refreshToken: 'x', client }),
    ).rejects.toMatchObject(invalid);
    const saved = sessions.save.mock.calls[0][0];
    expect(saved.revokedReason).toBe('refresh_reuse');
    expect(saved.revokedAt).toEqual(NOW);
    expect(sessions.rotateRefreshToken).not.toHaveBeenCalled();
  });

  it('treats a hash of a different length as a mismatch', async () => {
    codec.parse.mockReturnValue({ sessionId: 's1', hash: 'abcd' });
    await expect(
      useCase.execute({ refreshToken: 'x', client }),
    ).rejects.toMatchObject(invalid);
    expect(sessions.save.mock.calls[0][0].revokedReason).toBe('refresh_reuse');
  });

  it('treats a lost rotation race as reuse', async () => {
    sessions.rotateRefreshToken.mockResolvedValue(false);
    await expect(
      useCase.execute({ refreshToken: 'x', client }),
    ).rejects.toMatchObject(invalid);
    expect(access.issue).not.toHaveBeenCalled();
    const saved = sessions.save.mock.calls[0][0];
    expect(saved.revokedReason).toBe('refresh_reuse');
    // The reloaded row is revoked, not the in-memory session carrying the unsaved rotated hash.
    expect(saved.refreshTokenHash).toBe(hexHash(1));
  });
});
