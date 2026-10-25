import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import {
  SpaceGrantRepository,
  type SpaceGrant,
} from '../../domain/space-grant.repository.js';
import { distinctSorted, spaceKeyNotFound, updatedRows } from './db-helpers.js';

@Injectable()
export class SpaceGrantTypeormRepository extends SpaceGrantRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // Uma linha por (versão, usuário), para sempre: troca o valor da ativa ou limpa a lápide da última; só
  // insere quando nunca houve. O INSERT pega organization_id da versão (da organização do contexto) e, numa
  // corrida de dois INSERTs, o segundo cai no ON CONFLICT do índice parcial e só atualiza.
  async upsert(
    orgId: string,
    spaceKeyId: string,
    userId: string,
    wrappedKey: string,
  ): Promise<void> {
    await runInOrganizationScope(this.dataSource, orgId, async (m) => {
      const revived = updatedRows(
        await m.query(
          `UPDATE space_key_grants
              SET wrapped_key = $4, deleted_at = NULL, updated_at = now()
            WHERE id = (
              SELECT g.id FROM space_key_grants g
                JOIN space_keys k ON k.id = g.space_key_id AND k.organization_id = g.organization_id
               WHERE g.organization_id = $1 AND g.space_key_id = $2 AND g.user_id = $3
                 AND k.deleted_at IS NULL
               ORDER BY (g.deleted_at IS NULL) DESC, g.deleted_at DESC, g.id DESC
               LIMIT 1)
           RETURNING id`,
          [orgId, spaceKeyId, userId, wrappedKey],
        ),
      );
      if (revived.length > 0) return;
      const inserted: { id: string }[] = await m.query(
        `INSERT INTO space_key_grants (organization_id, space_key_id, user_id, wrapped_key)
         SELECT k.organization_id, k.id, $3, $4
           FROM space_keys k
          WHERE k.id = $2 AND k.organization_id = $1 AND k.deleted_at IS NULL
         ON CONFLICT (space_key_id, user_id) WHERE user_id IS NOT NULL AND deleted_at IS NULL
         DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key, updated_at = now()
         RETURNING id`,
        [orgId, spaceKeyId, userId, wrappedKey],
      );
      if (inserted.length === 0) {
        throw spaceKeyNotFound();
      }
    });
  }

  async forUser(
    orgId: string,
    spaceId: string,
    userId: string,
  ): Promise<SpaceGrant[]> {
    const rows: {
      space_key_id: string;
      version: number;
      wrapped_key: string;
    }[] = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `SELECT g.space_key_id, k.version, g.wrapped_key
             FROM space_key_grants g
             JOIN space_keys k ON k.id = g.space_key_id AND k.organization_id = g.organization_id
            WHERE g.organization_id = $1 AND k.space_id = $2 AND g.user_id = $3
              AND g.deleted_at IS NULL AND k.deleted_at IS NULL
            ORDER BY k.version ASC`,
        [orgId, spaceId, userId],
      ),
    );
    return rows.map((r) => ({
      spaceKeyId: r.space_key_id,
      version: r.version,
      wrappedKey: r.wrapped_key,
    }));
  }

  // Lápide em todas as versões (o hub apaga a cópia local ao sincronizar).
  async tombstoneUser(
    orgId: string,
    spaceId: string,
    userId: string,
  ): Promise<void> {
    await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `UPDATE space_key_grants g
            SET deleted_at = now(), updated_at = now()
           FROM space_keys k
          WHERE k.id = g.space_key_id AND k.organization_id = g.organization_id
            AND g.organization_id = $1 AND k.space_id = $2 AND g.user_id = $3
            AND g.deleted_at IS NULL`,
        [orgId, spaceId, userId],
      ),
    );
  }

  async tombstoneUserInOrg(orgId: string, userId: string): Promise<string[]> {
    const raw: unknown = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `UPDATE space_key_grants g
              SET deleted_at = now(), updated_at = now()
             FROM space_keys k
            WHERE k.id = g.space_key_id AND k.organization_id = g.organization_id
              AND g.organization_id = $1 AND g.user_id = $2 AND g.deleted_at IS NULL
           RETURNING k.space_id`,
          [orgId, userId],
        ),
    );
    return distinctSorted(
      updatedRows<{ space_id: string }>(raw).map((r) => r.space_id),
    );
  }
}
