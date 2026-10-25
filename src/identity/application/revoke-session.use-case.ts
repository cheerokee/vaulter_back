import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../../shared/domain/errors.js';
import { SessionRepository } from '../domain/session.repository.js';
import type { Actor } from './dto/actor.js';

@Injectable()
export class RevokeSessionUseCase {
  constructor(private readonly sessions: SessionRepository) {}

  async execute(auth: Actor, sessionId: string): Promise<void> {
    const session = await this.sessions.findById(sessionId);
    // Sessions of other users look the same as missing ones.
    if (!session || session.userId !== auth.userId) {
      throw new NotFoundError('session-not-found', 'Session not found.');
    }
    if (session.revokedAt !== null) return;
    session.revoke('revoked', new Date());
    await this.sessions.save(session);
  }
}
