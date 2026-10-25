import { Injectable } from '@nestjs/common';
import { SessionRepository } from '../domain/session.repository.js';
import type { Actor } from './dto/actor.js';

@Injectable()
export class LogoutUseCase {
  constructor(private readonly sessions: SessionRepository) {}

  async execute(auth: Actor): Promise<void> {
    const session = await this.sessions.findById(auth.sessionId);
    if (!session || session.revokedAt !== null) return;
    session.revoke('logout', new Date());
    await this.sessions.save(session);
  }
}
