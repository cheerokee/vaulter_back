import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource } from 'typeorm';
import {
  decodeCursor,
  encodeCursor,
  type CursorPage,
  type CursorPageRequest,
} from '../../../shared/domain/pagination.js';
import {
  currentManager,
  runWithContext,
} from '../../../shared/infra/db/unit-of-work.js';
import type { Hub } from '../../domain/hub.js';
import { HubRepository } from '../../domain/hub.repository.js';
import { hubNotFound, requireUnitOfWork } from './db-helpers.js';
import { HubTypeormEntity } from './hub.entity.js';
import { HubMapper, type HubRow } from './hub.mapper.js';

// Roda no contexto ambiente: quem chama põe `app.user_id` (dono/membro) ou `app.hub_id` (o próprio Hub) com o
// UnitOfWork; o RLS decide o que é visível. A única exceção é a busca por chave de assinatura, que abre só a
// linha daquela chave (`app.hub_signing_public_key`), sem contexto nenhum.
@Injectable()
export class HubTypeormRepository extends HubRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  private get repo() {
    return currentManager(this.dataSource).getRepository(HubTypeormEntity);
  }

  async create(hub: Hub): Promise<void> {
    await this.repo.insert(HubMapper.toPersistence(hub));
  }

  // Sem linha alterada = Hub inexistente ou invisível no contexto: falha alto, nunca grava em silêncio.
  async save(hub: Hub): Promise<void> {
    const { name, lastSeenAt, deletedAt } = HubMapper.toPersistence(hub);
    const result = await this.repo.update(
      { id: hub.id },
      { name, lastSeenAt, deletedAt },
    );
    if (!result.affected) throw hubNotFound();
  }

  async findById(hubId: string): Promise<Hub | null> {
    if (!validate(hubId)) return null;
    const row = await this.repo.findOne({
      where: { id: hubId },
      withDeleted: true,
    });
    return row ? HubMapper.toDomain(row) : null;
  }

  async findBySigningKey(signingPublicKey: string): Promise<Hub | null> {
    const row = await runWithContext(
      this.dataSource,
      { hubSigningPublicKey: signingPublicKey },
      (m) =>
        m.getRepository(HubTypeormEntity).findOne({
          where: { signingPublicKey },
          withDeleted: true,
        }),
    );
    return row ? HubMapper.toDomain(row) : null;
  }

  // O filtro explícito (dono ou vínculo aprovado com organização de que a pessoa é membro ativo) é a primeira
  // trava; o RLS do `app.user_id` é a segunda. Ordem por id (v7 = ordem de criação).
  async listForUser(
    userId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<Hub>> {
    if (!validate(userId)) return { items: [], nextCursor: null };
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows: HubRow[] = await currentManager(this.dataSource).query(
      `SELECT h.* FROM hubs h
        WHERE h.deleted_at IS NULL
          AND (h.owner_user_id = $1 OR EXISTS (
                SELECT 1 FROM hub_organization ho
                  JOIN user_organization uo
                    ON uo.organization_id = ho.organization_id
                   AND uo.user_id = $1 AND uo.deleted_at IS NULL
                 WHERE ho.hub_id = h.id AND ho.status = 'approved' AND ho.deleted_at IS NULL))
          AND ($2::uuid IS NULL OR h.id > $2::uuid)
        ORDER BY h.id ASC
        LIMIT $3`,
      [userId, cursor, page.limit + 1],
    );
    const items = rows.slice(0, page.limit).map((r) => HubMapper.fromRow(r));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > page.limit && last ? encodeCursor(last.id) : null,
    };
  }

  // FOR UPDATE também exige a policy de UPDATE: só o dono ou o próprio Hub travam.
  async lockForUpdate(hubId: string): Promise<Hub | null> {
    requireUnitOfWork(this.dataSource, 'HubRepository.lockForUpdate');
    if (!validate(hubId)) return null;
    const row = await this.repo.findOne({
      where: { id: hubId },
      withDeleted: true,
      lock: { mode: 'pessimistic_write' },
    });
    return row ? HubMapper.toDomain(row) : null;
  }
}
