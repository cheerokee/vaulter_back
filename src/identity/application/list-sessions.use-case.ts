import { Injectable } from '@nestjs/common';
import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import { SessionRepository } from '../domain/session.repository.js';
import type { Actor } from './dto/actor.js';
import { toSessionView, type SessionView } from './dto/session-view.js';

@Injectable()
export class ListSessionsUseCase {
  constructor(private readonly sessions: SessionRepository) {}

  async execute(
    auth: Actor,
    page: CursorPageRequest,
  ): Promise<CursorPage<SessionView>> {
    const result = await this.sessions.listActiveByUser(
      auth.userId,
      new Date(),
      page,
    );
    return {
      items: result.items.map((s) => toSessionView(s, auth.sessionId)),
      nextCursor: result.nextCursor,
    };
  }
}
