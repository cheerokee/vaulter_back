import type { ConfigService } from '@nestjs/config';
import { isUuidV7 } from '../../shared/domain/id.js';
import type { SessionRepository } from '../domain/session.repository.js';
import { User } from '../domain/user.js';
import type { AccessTokenService } from './ports/access-token-service.js';
import type { RefreshTokenCodec } from './ports/refresh-token-codec.js';
import { SessionIssuer } from './session-issuer.js';

const b64 = (n: number, fill = 1) =>
  Buffer.alloc(n, fill).toString('base64url');

function makeUser(): User {
  const epk = Buffer.alloc(73, 2);
  epk[0] = 1;
  return User.register({
    name: 'Ana',
    email: 'ana@x.com',
    authHash: 'hash',
    kdfSalt: b64(16),
    kdfParams: {
      algorithm: 'argon2id13',
      opsLimit: 3,
      memLimitBytes: 67108864,
    },
    publicKey: b64(32),
    encryptedPrivateKey: epk.toString('base64url'),
    now: new Date('2026-10-24T11:00:00Z'),
  });
}

describe('SessionIssuer', () => {
  const now = new Date('2026-10-24T12:00:00Z');

  it('creates the session with the refresh hash and emits both tokens', async () => {
    const sessions = { create: vi.fn().mockResolvedValue(undefined) };
    const codec = {
      generate: vi.fn().mockResolvedValue({ token: 'rt', hash: 'h' }),
    };
    const expiresAt = new Date('2026-10-24T12:15:00Z');
    const access = {
      issue: vi.fn().mockResolvedValue({ token: 'at', expiresAt }),
    };
    const config = { getOrThrow: vi.fn().mockReturnValue('30') };
    const issuer = new SessionIssuer(
      sessions as unknown as SessionRepository,
      codec as unknown as RefreshTokenCodec,
      access as unknown as AccessTokenService,
      config as unknown as ConfigService,
    );
    const user = makeUser();

    const out = await issuer.start(
      user,
      { name: 'Pixel', platform: 'android' },
      { ip: '1.2.3.4', userAgent: 'ua' },
      now,
    );

    expect(isUuidV7(out.sessionId)).toBe(true);
    expect(codec.generate).toHaveBeenCalledWith(out.sessionId);
    const created = sessions.create.mock.calls[0]![0];
    expect(created.id).toBe(out.sessionId);
    expect(created.userId).toBe(user.id);
    expect(created.refreshTokenHash).toBe('h');
    expect(created.deviceName).toBe('Pixel');
    expect(created.lastIp).toBe('1.2.3.4');
    expect(config.getOrThrow).toHaveBeenCalledWith(
      'AUTH_REFRESH_TOKEN_IDLE_DAYS',
    );
    expect(out).toEqual({
      sessionId: out.sessionId,
      accessToken: 'at',
      accessTokenExpiresAt: expiresAt,
      refreshToken: 'rt',
      refreshTokenExpiresAt: new Date('2026-11-23T12:00:00Z'),
    });
    expect(access.issue).toHaveBeenCalledWith(
      { userId: user.id, sessionId: out.sessionId },
      now,
    );
  });
});
