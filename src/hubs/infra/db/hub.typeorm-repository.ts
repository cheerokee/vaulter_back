import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource, QueryFailedError } from 'typeorm';
import { ConflictError } from '../../../shared/domain/errors.js';
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
import { hubNotFound, requireUnitOfWork, updatedRows } from './db-helpers.js';
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

  // A chave é única para sempre: a corrida entre duas reivindicações da mesma chave cai aqui (23505).
  async create(hub: Hub): Promise<void> {
    try {
      await this.repo.insert(HubMapper.toPersistence(hub));
    } catch (error) {
      const driver =
        error instanceof QueryFailedError
          ? (error.driverError as { code?: string; constraint?: string })
          : undefined;
      if (
        driver?.code === '23505' &&
        driver.constraint === 'uq_hubs_signing_public_key'
      ) {
        throw new ConflictError(
          'signing-key-in-use',
          'This signing key already belongs to a hub.',
        );
      }
      throw error;
    }
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

  // Só para responder "chave já em uso" (inclusive por Hub desregistrado) na apresentação: o Hub achado nunca é
  // devolvido a quem chamou a rota (a policy hubs_by_signing_key abre a linha sem nenhum outro contexto).
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

  // Uma leitura por Hub, cada uma no contexto do próprio Hub (`app.hub_id` abre uma linha só); a página tem no máximo
  // 100 itens. Só o nome sai daqui.
  async namesOf(hubIds: readonly string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const hubId of new Set(hubIds)) {
      if (!validate(hubId)) continue;
      const rows: { name: string }[] = await runWithContext(
        this.dataSource,
        { hubId },
        (m) =>
          m.query(
            `SELECT name FROM hubs WHERE id = $1 AND deleted_at IS NULL`,
            [hubId],
          ),
      );
      if (rows[0]) names.set(hubId, rows[0].name);
    }
    return names;
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

  // FOR SHARE também exige a policy de UPDATE de hubs: roda no contexto do próprio Hub (`app.hub_id`), só neste
  // trecho, para qualquer caso de uso (dono, admin aprovando, quem pede com código) travar. O lock passa do
  // savepoint para a transação de fora. Desregistrado (lápide) = null, também para quem esperou o desregistro.
  async lockForShare(hubId: string): Promise<Hub | null> {
    requireUnitOfWork(this.dataSource, 'HubRepository.lockForShare');
    if (!validate(hubId)) return null;
    const rows: HubRow[] = await runWithContext(
      this.dataSource,
      { hubId },
      (m) =>
        m.query(
          `SELECT * FROM hubs WHERE id = $1 AND deleted_at IS NULL FOR SHARE`,
          [hubId],
        ),
    );
    return rows[0] ? HubMapper.fromRow(rows[0]) : null;
  }

  // Mesmo contexto do `lockForShare` (a policy de UPDATE de hubs libera o próprio Hub). Com `nowait`, 55P03 (lock em
  // uso) vira 409: o savepoint do contexto desfaz só esta tentativa, mas o erro sobe e desfaz o caso de uso.
  async lockForStorage(
    hubId: string,
    opts: { nowait?: boolean } = {},
  ): Promise<Hub | null> {
    requireUnitOfWork(this.dataSource, 'HubRepository.lockForStorage');
    if (!validate(hubId)) return null;
    try {
      const rows: HubRow[] = await runWithContext(
        this.dataSource,
        { hubId },
        (m) =>
          m.query(
            `SELECT * FROM hubs WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE${opts.nowait ? ' NOWAIT' : ''}`,
            [hubId],
          ),
      );
      return rows[0] ? HubMapper.fromRow(rows[0]) : null;
    } catch (error) {
      const code =
        error instanceof QueryFailedError
          ? (error.driverError as { code?: string }).code
          : undefined;
      if (code === '55P03') {
        throw new ConflictError(
          'hub-storage-busy',
          'A hub this space is on is changing right now; try again.',
        );
      }
      throw error;
    }
  }

  // Só a coluna da capacidade (GRANT de UPDATE por coluna): nunca grava nome/lápide lidos antes.
  async setStorageCapacity(hubId: string, bytes: number): Promise<boolean> {
    if (!validate(hubId)) return false;
    const rows = updatedRows<{ id: string }>(
      await currentManager(this.dataSource).query(
        `UPDATE hubs SET storage_capacity_bytes = $2, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL
         RETURNING id`,
        [hubId, bytes],
      ),
    );
    return rows.length > 0;
  }
}
