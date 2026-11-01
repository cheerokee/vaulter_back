import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { LinkCode } from '../../domain/link-code.js';
import { LinkCodeRepository } from '../../domain/link-code.repository.js';
import { updatedRows } from './db-helpers.js';
import { HubLinkCodeTypeormEntity } from './hub-link-code.entity.js';
import { LinkCodeMapper, type LinkCodeRow } from './link-code.mapper.js';

// Tabela só do backend (sem RLS): alcançada só pelo hash do código.
@Injectable()
export class LinkCodeTypeormRepository extends LinkCodeRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async create(code: LinkCode): Promise<void> {
    await currentManager(this.dataSource)
      .getRepository(HubLinkCodeTypeormEntity)
      .insert(LinkCodeMapper.toPersistence(code));
  }

  // Um UPDATE condicional com RETURNING: entre chamadas concorrentes, só a que alterou a linha recebe o código.
  // Desconhecido, usado e vencido dão o mesmo `null`.
  async consume(codeHash: string, now: Date): Promise<LinkCode | null> {
    const rows = updatedRows<LinkCodeRow>(
      await currentManager(this.dataSource).query(
        `UPDATE hub_link_codes SET used_at = $2, updated_at = now()
          WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2 AND deleted_at IS NULL
         RETURNING id, hub_id, code_hash, expires_at, used_at, created_at`,
        [codeHash, now],
      ),
    );
    const row = rows[0];
    return row ? LinkCodeMapper.fromRow(row) : null;
  }

  // Lápide (o runtime não tem DELETE) nos vencidos não usados: o único parcial ignora lápides, então o hash fica
  // livre para um código novo. Usados ficam como histórico.
  async expireStale(now: Date): Promise<number> {
    const rows = updatedRows<{ id: string }>(
      await currentManager(this.dataSource).query(
        `UPDATE hub_link_codes SET deleted_at = $1, updated_at = now()
          WHERE used_at IS NULL AND deleted_at IS NULL AND expires_at <= $1
         RETURNING id`,
        [now],
      ),
    );
    return rows.length;
  }
}
