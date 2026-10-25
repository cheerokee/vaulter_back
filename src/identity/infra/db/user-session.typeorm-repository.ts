import { Injectable } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import {
  decodeCursor,
  encodeCursor,
  type CursorPage,
  type CursorPageRequest,
} from '../../../shared/domain/pagination.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { Session, SessionRevokedReason } from '../../domain/session.js';
import { SessionRepository } from '../../domain/session.repository.js';
import { UserSessionTypeormEntity } from './user-session.entity.js';
import { UserSessionMapper } from './user-session.mapper.js';

@Injectable()
export class UserSessionTypeormRepository extends SessionRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // Resolvido a cada operação: dentro de um UnitOfWork.run, usa a transação ativa.
  private get repo(): Repository<UserSessionTypeormEntity> {
    return currentManager(this.dataSource).getRepository(
      UserSessionTypeormEntity,
    );
  }

  async create(session: Session): Promise<void> {
    await this.repo.insert(UserSessionMapper.toPersistence(session));
  }

  async findById(id: string): Promise<Session | null> {
    const row = await this.repo.findOne({ where: { id } });
    return row ? UserSessionMapper.toDomain(row) : null;
  }

  async listActiveByUser(
    userId: string,
    now: Date,
    page: CursorPageRequest,
  ): Promise<CursorPage<Session>> {
    const qb = this.repo
      .createQueryBuilder('s')
      .where('s.user_id = :userId', { userId })
      .andWhere('s.revoked_at IS NULL')
      .andWhere('s.refresh_expires_at > :now', { now })
      .orderBy('s.id', 'DESC')
      .limit(page.limit + 1);
    if (page.cursor) {
      qb.andWhere('s.id < :cursor', { cursor: decodeCursor(page.cursor) });
    }
    const rows = await qb.getMany();
    const items = rows
      .slice(0, page.limit)
      .map((r) => UserSessionMapper.toDomain(r));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > page.limit && last ? encodeCursor(last.id) : null,
    };
  }

  async rotateRefreshToken(
    session: Session,
    expectedHash: string,
  ): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(UserSessionTypeormEntity)
      .set({
        refreshTokenHash: session.refreshTokenHash,
        refreshExpiresAt: session.refreshExpiresAt,
        lastUsedAt: session.lastUsedAt,
        lastIp: session.lastIp,
        userAgent: session.userAgent,
      })
      .where('id = :id', { id: session.id })
      .andWhere('refresh_token_hash = :expectedHash', { expectedHash })
      .andWhere('revoked_at IS NULL')
      .andWhere('deleted_at IS NULL')
      .execute();
    return result.affected === 1;
  }

  async revoke(
    sessionId: string,
    reason: SessionRevokedReason,
    now: Date,
  ): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(UserSessionTypeormEntity)
      .set({ revokedAt: now, revokedReason: reason })
      .where('id = :sessionId', { sessionId })
      .andWhere('revoked_at IS NULL')
      .andWhere('deleted_at IS NULL')
      .execute();
    return result.affected === 1;
  }

  async revokeAllForUser(
    userId: string,
    reason: SessionRevokedReason,
    now: Date,
    exceptSessionId?: string,
  ): Promise<void> {
    const qb = this.repo
      .createQueryBuilder()
      .update(UserSessionTypeormEntity)
      .set({ revokedAt: now, revokedReason: reason })
      .where('user_id = :userId', { userId })
      .andWhere('revoked_at IS NULL')
      .andWhere('deleted_at IS NULL');
    if (exceptSessionId)
      qb.andWhere('id <> :exceptSessionId', { exceptSessionId });
    await qb.execute();
  }
}
