import { Injectable } from '@nestjs/common';
import { SessionRepository } from '../domain/session.repository.js';
import type { Actor } from './dto/actor.js';

@Injectable()
export class LogoutUseCase {
  constructor(private readonly sessions: SessionRepository) {}

  async execute(auth: Actor): Promise<void> {
    // Idempotent: an already revoked session keeps its first reason.
    await this.sessions.revoke(auth.sessionId, 'logout', new Date());
  }
}
