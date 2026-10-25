import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { newId } from '../../shared/domain/id.js';
import { Session, type DevicePlatform } from '../domain/session.js';
import { SessionRepository } from '../domain/session.repository.js';
import type { User } from '../domain/user.js';
import type { SessionTokens } from './dto/session-tokens.js';
import { AccessTokenService } from './ports/access-token-service.js';
import { RefreshTokenCodec } from './ports/refresh-token-codec.js';

export type DeviceInput = { name: string; platform: DevicePlatform };
export type ClientInfo = { ip: string | null; userAgent: string | null };

/** Creates a device session and emits its access/refresh token pair. */
@Injectable()
export class SessionIssuer {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly refreshCodec: RefreshTokenCodec,
    private readonly accessTokens: AccessTokenService,
    private readonly config: ConfigService,
  ) {}

  async start(
    user: User,
    device: DeviceInput,
    client: ClientInfo,
    now: Date,
  ): Promise<SessionTokens> {
    const sessionId = newId();
    const refresh = await this.refreshCodec.generate(sessionId);
    const session = Session.start({
      id: sessionId,
      userId: user.id,
      deviceName: device.name,
      devicePlatform: device.platform,
      refreshTokenHash: refresh.hash,
      idleDays: Number(
        this.config.getOrThrow<number>('AUTH_REFRESH_TOKEN_IDLE_DAYS'),
      ),
      now,
      ip: client.ip,
      userAgent: client.userAgent,
    });
    await this.sessions.create(session);
    const access = await this.accessTokens.issue(
      { userId: user.id, sessionId },
      now,
    );
    return {
      sessionId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: session.refreshExpiresAt,
    };
  }
}
