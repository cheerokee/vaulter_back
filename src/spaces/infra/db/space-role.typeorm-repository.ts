import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  decodeCursor,
  type CursorPage,
  type CursorPageRequest,
} from '../../../shared/domain/pagination.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import type { SpaceRoleKey } from '../../domain/space-membership.js';
import {
  SpaceRoleRepository,
  type SpaceMember,
} from '../../domain/space-role.repository.js';
import {
  distinctSorted,
  requireUnitOfWork,
  spaceFactoryRoleId,
  toCursorPage,
  updatedRows,
} from './db-helpers.js';

// Membro do espaço = atribuição ativa em role_assignments com scope_type = 'space' (decisão 4), com
// organization_id preenchido para o RLS por organização. uq_role_assignments_space_user garante no máximo uma
// ativa por (space_id, user_id).
const ACTIVE = `ra.organization_id = $1 AND ra.space_id = $2 AND ra.scope_type = 'space' AND ra.deleted_at IS NULL`;

@Injectable()
export class SpaceRoleTypeormRepository extends SpaceRoleRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // Troca o papel da ativa ou limpa a lápide da última (uma linha por pessoa em cada espaço); só insere
  // quando nunca houve, com o espaço conferido na organização do contexto. Corrida de dois INSERTs: o
  // segundo cai no ON CONFLICT do índice parcial.
  async assign(
    orgId: string,
    spaceId: string,
    userId: string,
    roleKey: SpaceRoleKey,
    grantedBy: string | null,
  ): Promise<void> {
    await runInOrganizationScope(this.dataSource, orgId, async (m) => {
      const roleId = await spaceFactoryRoleId(m, roleKey);
      const revived = updatedRows(
        await m.query(
          `UPDATE role_assignments
            SET role_id = $4, granted_by_user_id = $5, deleted_at = NULL, updated_at = now()
          WHERE id = (
            SELECT ra.id FROM role_assignments ra
             WHERE ra.organization_id = $1 AND ra.space_id = $2 AND ra.user_id = $3
               AND ra.scope_type = 'space'
             ORDER BY (ra.deleted_at IS NULL) DESC, ra.deleted_at DESC, ra.id DESC
             LIMIT 1)
         RETURNING id`,
          [orgId, spaceId, userId, roleId, grantedBy],
        ),
      );
      if (revived.length > 0) return;
      const inserted: { id: string }[] = await m.query(
        `INSERT INTO role_assignments (role_id, user_id, scope_type, organization_id, space_id, granted_by_user_id)
         SELECT $4, $3, 'space', s.organization_id, s.id, $5
           FROM spaces s
          WHERE s.id = $2 AND s.organization_id = $1 AND s.deleted_at IS NULL
         ON CONFLICT (space_id, user_id) WHERE scope_type = 'space' AND deleted_at IS NULL
         DO UPDATE SET role_id = EXCLUDED.role_id,
                       granted_by_user_id = EXCLUDED.granted_by_user_id,
                       updated_at = now()
         RETURNING id`,
        [orgId, spaceId, userId, roleId, grantedBy],
      );
      if (inserted.length === 0) {
        throw new Error(
          'SpaceRoleRepository.assign: the space does not exist in this organization.',
        );
      }
    });
  }

  async roleOf(
    orgId: string,
    spaceId: string,
    userId: string,
  ): Promise<SpaceRoleKey | null> {
    const rows: { key: SpaceRoleKey }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT r.key FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
            WHERE ${ACTIVE} AND ra.user_id = $3`,
          [orgId, spaceId, userId],
        ),
    );
    return rows[0]?.key ?? null;
  }

  async remove(orgId: string, spaceId: string, userId: string): Promise<void> {
    await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `UPDATE role_assignments ra SET deleted_at = now(), updated_at = now()
          WHERE ${ACTIVE} AND ra.user_id = $3`,
        [orgId, spaceId, userId],
      ),
    );
  }

  async activeMemberIds(orgId: string, spaceId: string): Promise<string[]> {
    const rows: { user_id: string }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT ra.user_id FROM role_assignments ra WHERE ${ACTIVE} ORDER BY ra.user_id`,
          [orgId, spaceId],
        ),
    );
    return rows.map((r) => r.user_id);
  }

  // Ordem por user_id (v7); o cursor é o último user_id. joinedAt = created_at da linha (numa reentrada, a
  // linha é a mesma: fica a data da primeira entrada).
  async listMembers(
    orgId: string,
    spaceId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<SpaceMember>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows: {
      user_id: string;
      role_key: SpaceRoleKey;
      created_at: Date;
    }[] = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `SELECT ra.user_id, r.key AS role_key, ra.created_at
             FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
            WHERE ${ACTIVE} AND ($3::uuid IS NULL OR ra.user_id > $3::uuid)
            ORDER BY ra.user_id ASC
            LIMIT $4`,
        [orgId, spaceId, cursor, page.limit + 1],
      ),
    );
    const items = rows.slice(0, page.limit).map((r) => ({
      userId: r.user_id,
      roleKey: r.role_key,
      joinedAt: r.created_at,
    }));
    return toCursorPage(items, rows.length > page.limit, (i) => i.userId);
  }

  // SELECT ... FOR UPDATE OF ra na transação ambiente, em ordem estável (o mesmo padrão do lockOrgAdmins).
  async lockSpaceManagers(orgId: string, spaceId: string): Promise<string[]> {
    requireUnitOfWork(this.dataSource, 'SpaceRoleRepository.lockSpaceManagers');
    const rows: { user_id: string }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT ra.user_id
             FROM role_assignments ra
             JOIN roles r ON r.id = ra.role_id
            WHERE ${ACTIVE}
              AND r.key = 'space_manager' AND r.organization_id IS NULL
            ORDER BY ra.user_id
              FOR UPDATE OF ra`,
          [orgId, spaceId],
        ),
    );
    return distinctSorted(rows.map((r) => r.user_id));
  }

  async removeUserInOrg(orgId: string, userId: string): Promise<string[]> {
    const raw: unknown = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `UPDATE role_assignments SET deleted_at = now(), updated_at = now()
          WHERE organization_id = $1 AND user_id = $2 AND scope_type = 'space' AND deleted_at IS NULL
         RETURNING space_id`,
          [orgId, userId],
        ),
    );
    return distinctSorted(
      updatedRows<{ space_id: string }>(raw).map((r) => r.space_id),
    );
  }
}
