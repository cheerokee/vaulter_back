import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  decodeCursor,
  type CursorPage,
  type CursorPageRequest,
} from '../../../shared/domain/pagination.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import {
  PendingGrantRepository,
  type NewPendingGrant,
  type PendingGrant,
  type PendingGrantStatus,
} from '../../domain/pending-grant.repository.js';
import type { SpaceRoleKey } from '../../domain/space-membership.js';
import { spaceFactoryRoleId, toCursorPage, updatedRows } from './db-helpers.js';

type PendingRow = {
  id: string;
  space_id: string;
  user_id: string;
  role_key: SpaceRoleKey;
  invitation_id: string | null;
  requested_by_user_id: string | null;
  status: PendingGrantStatus;
  created_at: Date;
};

const SELECT = `
  SELECT pg.id, pg.space_id, pg.user_id, r.key AS role_key, pg.invitation_id, pg.requested_by_user_id,
         pg.status, pg.created_at
    FROM space_pending_grants pg JOIN roles r ON r.id = pg.role_id`;

const OPEN = `pg.organization_id = $1 AND pg.space_id = $2 AND pg.status = 'pending' AND pg.deleted_at IS NULL`;

// Só do backend. Resolver uma pendência muda o status (fica de histórico); uq_space_pending_grants_open
// garante uma aberta por pessoa em cada espaço.
@Injectable()
export class PendingGrantTypeormRepository extends PendingGrantRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // organization_id vem do espaço (que precisa ser da organização do contexto).
  async create(orgId: string, grant: NewPendingGrant): Promise<void> {
    await runInOrganizationScope(this.dataSource, orgId, async (m) => {
      const roleId = await spaceFactoryRoleId(m, grant.roleKey);
      const rows: { id: string }[] = await m.query(
        `INSERT INTO space_pending_grants
                (id, organization_id, space_id, user_id, role_id, invitation_id, requested_by_user_id)
         SELECT $3, s.organization_id, s.id, $4, $5, $6, $7
           FROM spaces s
          WHERE s.id = $2 AND s.organization_id = $1 AND s.deleted_at IS NULL
         RETURNING id`,
        [
          orgId,
          grant.spaceId,
          grant.id,
          grant.userId,
          roleId,
          grant.invitationId,
          grant.requestedByUserId,
        ],
      );
      if (rows.length === 0) {
        throw new Error(
          'PendingGrantRepository.create: the space does not exist in this organization.',
        );
      }
    });
  }

  async findPending(
    orgId: string,
    spaceId: string,
    userId: string,
  ): Promise<PendingGrant | null> {
    const rows: PendingRow[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(`${SELECT} WHERE ${OPEN} AND pg.user_id = $3`, [
          orgId,
          spaceId,
          userId,
        ]),
    );
    return rows[0] ? toPendingGrant(rows[0]) : null;
  }

  // Ordem por id (v7 = ordem de criação); o cursor é o último id.
  async listPending(
    orgId: string,
    spaceId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<PendingGrant>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows: PendingRow[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `${SELECT} WHERE ${OPEN} AND ($3::uuid IS NULL OR pg.id > $3::uuid)
           ORDER BY pg.id ASC LIMIT $4`,
          [orgId, spaceId, cursor, page.limit + 1],
        ),
    );
    const items = rows.slice(0, page.limit).map(toPendingGrant);
    return toCursorPage(items, rows.length > page.limit, (i) => i.id);
  }

  async decline(
    orgId: string,
    spaceId: string,
    userId: string,
  ): Promise<boolean> {
    return (await this.resolve(orgId, spaceId, userId, 'declined')) > 0;
  }

  async markGranted(
    orgId: string,
    spaceId: string,
    userId: string,
  ): Promise<void> {
    await this.resolve(orgId, spaceId, userId, 'granted');
  }

  async cancelForUser(orgId: string, userId: string): Promise<number> {
    const raw: unknown = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `UPDATE space_pending_grants SET status = 'cancelled', updated_at = now()
            WHERE organization_id = $1 AND user_id = $2 AND status = 'pending' AND deleted_at IS NULL
           RETURNING id`,
          [orgId, userId],
        ),
    );
    return updatedRows(raw).length;
  }

  // UPDATE condicional: numa corrida, só um muda a pendência aberta.
  private async resolve(
    orgId: string,
    spaceId: string,
    userId: string,
    status: Exclude<PendingGrantStatus, 'pending'>,
  ): Promise<number> {
    const raw: unknown = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `UPDATE space_pending_grants pg SET status = $4, updated_at = now()
            WHERE ${OPEN} AND pg.user_id = $3
           RETURNING pg.id`,
          [orgId, spaceId, userId, status],
        ),
    );
    return updatedRows(raw).length;
  }
}

function toPendingGrant(row: PendingRow): PendingGrant {
  return {
    id: row.id,
    spaceId: row.space_id,
    userId: row.user_id,
    roleKey: row.role_key,
    invitationId: row.invitation_id,
    requestedByUserId: row.requested_by_user_id,
    status: row.status,
    createdAt: row.created_at,
  };
}
