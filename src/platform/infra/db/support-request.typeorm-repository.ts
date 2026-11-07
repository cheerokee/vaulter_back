import { Injectable } from '@nestjs/common';
import { DataSource, type SelectQueryBuilder } from 'typeorm';
import {
  decodeCursor,
  pageFrom,
  type CursorPage,
  type CursorPageRequest,
} from '../../../shared/domain/pagination.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { SupportRequest } from '../../domain/support-request.js';
import {
  SupportRequestRepository,
  type SupportRequestFilter,
} from '../../domain/support-request.repository.js';
import { PlatformSupportRequestTypeormEntity } from './platform-support-request.entity.js';
import { SupportRequestMapper } from './support-request.mapper.js';

// Sem RLS (tabela só do backend). O runtime tem SELECT/INSERT/UPDATE; cada operação usa o manager corrente, para
// entrar na transação do UnitOfWork quando houver uma.
@Injectable()
export class SupportRequestTypeormRepository extends SupportRequestRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  private get repo() {
    return currentManager(this.dataSource).getRepository(
      PlatformSupportRequestTypeormEntity,
    );
  }

  private qb(): SelectQueryBuilder<PlatformSupportRequestTypeormEntity> {
    return this.repo.createQueryBuilder('r').where('r.deletedAt IS NULL');
  }

  async insert(request: SupportRequest): Promise<void> {
    await this.repo.insert(SupportRequestMapper.toPersistence(request));
  }

  async save(request: SupportRequest): Promise<void> {
    await this.repo.update(
      { id: request.id },
      {
        status: request.status,
        decidedByUserId: request.decidedBy,
        decidedAt: request.decidedAt,
        decisionNote: request.decisionNote,
        executedAt: request.executedAt,
        failureType: request.failureType,
      },
    );
  }

  async findById(id: string): Promise<SupportRequest | null> {
    const row = await this.qb().andWhere('r.id = :id', { id }).getOne();
    return row ? SupportRequestMapper.toDomain(row) : null;
  }

  async lockById(id: string): Promise<SupportRequest | null> {
    const row = await this.qb()
      .andWhere('r.id = :id', { id })
      .setLock('pessimistic_write')
      .getOne();
    return row ? SupportRequestMapper.toDomain(row) : null;
  }

  async lockDuePending(now: Date): Promise<SupportRequest[]> {
    const rows = await this.qb()
      .andWhere(`r.status = 'pending'`)
      .andWhere('r.decidedByUserId IS NULL')
      .andWhere('r.expiresAt <= :now', { now })
      .orderBy('r.id')
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();
    return rows.map((r) => SupportRequestMapper.toDomain(r));
  }

  async list(
    filter: SupportRequestFilter,
    page: CursorPageRequest,
  ): Promise<CursorPage<SupportRequest>> {
    const q = this.qb();
    if (filter.status)
      q.andWhere('r.status = :status', { status: filter.status });
    if (filter.requestedBy) {
      q.andWhere('r.requestedByUserId = :requestedBy', {
        requestedBy: filter.requestedBy,
      });
    }
    if (page.cursor) {
      q.andWhere('r.id < :cursor', { cursor: decodeCursor(page.cursor) });
    }
    const rows = await q
      .orderBy('r.id', 'DESC')
      .limit(page.limit + 1)
      .getMany();
    return pageFrom(
      rows.map((r) => SupportRequestMapper.toDomain(r)),
      page.limit,
      (r) => r.id,
    );
  }
}
