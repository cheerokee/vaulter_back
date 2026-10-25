import { Injectable } from '@nestjs/common';
import { UnauthenticatedError } from '../../shared/domain/errors.js';
import { SessionRepository } from '../domain/session.repository.js';
import type { Actor } from './dto/actor.js';
import { AccessTokenService } from './ports/access-token-service.js';

@Injectable()
export class AuthenticateAccessTokenUseCase {
  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly sessions: SessionRepository,
  ) {}

  async execute(token: string, now: Date): Promise<Actor> {
    const claims = await this.accessTokens.verify(token, now);
    const session = await this.sessions.findById(claims.sessionId);
    if (
      !session ||
      !session.isActive(now) ||
      session.userId !== claims.userId
    ) {
      throw new UnauthenticatedError(
        'invalid-access-token',
        'The access token is invalid or expired.',
      );
    }
    return { userId: claims.userId, sessionId: session.id };
  }
}
