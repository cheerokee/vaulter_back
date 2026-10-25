import { timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnauthenticatedError } from '../../shared/domain/errors.js';
import { SessionRepository } from '../domain/session.repository.js';
import type { SessionTokens } from './dto/session-tokens.js';
import { AccessTokenService } from './ports/access-token-service.js';
import { RefreshTokenCodec } from './ports/refresh-token-codec.js';
import { refreshIdleDays } from './refresh-idle-days.js';
import type { ClientInfo } from './session-issuer.js';

@Injectable()
export class RefreshSessionUseCase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly codec: RefreshTokenCodec,
    private readonly accessTokens: AccessTokenService,
    private readonly config: ConfigService,
  ) {}

  async execute(input: {
    refreshToken: string;
    client: ClientInfo;
  }): Promise<SessionTokens> {
    const now = new Date();
    const parsed =
      typeof input.refreshToken === 'string'
        ? this.codec.parse(input.refreshToken)
        : null;
    if (!parsed) throw invalidRefreshToken();
    const session = await this.sessions.findById(parsed.sessionId);
    if (!session) throw invalidRefreshToken();
    // Expired or revoked: nothing is written, so an old token cannot reopen anything.
    if (!session.isActive(now)) throw invalidRefreshToken();

    if (!sameHash(parsed.hash, session.refreshTokenHash)) {
      await this.revokeForReuse(session.id, now);
      throw invalidRefreshToken();
    }

    const expected = session.refreshTokenHash;
    const next = await this.codec.generate(session.id);
    session.rotate(
      next.hash,
      refreshIdleDays(this.config),
      now,
      input.client.ip,
      input.client.userAgent,
    );
    if (!(await this.sessions.rotateRefreshToken(session, expected))) {
      // Lost a race: someone else rotated first, so this token was already used.
      await this.revokeForReuse(session.id, now);
      throw invalidRefreshToken();
    }
    const access = await this.accessTokens.issue(
      { userId: session.userId, sessionId: session.id },
      now,
    );
    return {
      sessionId: session.id,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: next.token,
      refreshTokenExpiresAt: session.refreshExpiresAt,
    };
  }

  // Touches only the revocation columns, so the rotated (unsaved) hash is never persisted.
  private async revokeForReuse(sessionId: string, now: Date): Promise<void> {
    await this.sessions.revoke(sessionId, 'refresh_reuse', now);
  }
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function invalidRefreshToken(): UnauthenticatedError {
  return new UnauthenticatedError(
    'invalid-refresh-token',
    'The refresh token is invalid or expired.',
  );
}
