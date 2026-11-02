import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import type { SpaceRoleKey } from '../../domain/space-membership.js';
import { SpaceRoomRepository } from '../../domain/space-room.repository.js';
import {
  distinctSorted,
  spaceFactoryRoleId,
  spaceKeyNotFound,
  spaceNotFound,
  updatedRows,
} from './db-helpers.js';

// Sala de um Hub num espaço (decisão 7 do plano de hubs): atribuição em role_assignments com room_hub_id (escopo
// espaço, organization_id preenchido para o RLS; uq_role_assignments_space_room_hub: uma ativa por espaço e Hub)
// e as cópias em space_key_grants.hub_id (uq_space_key_grants_hub). Mesmo padrão das linhas de pessoa: uma linha
// por (espaço, Hub) e por (versão, Hub) para sempre; voltar limpa a lápide. hub_id/room_hub_id ainda sem FK (a
// tabela hubs chega no módulo de hubs).
const ACTIVE_ROOM = `ra.organization_id = $1 AND ra.space_id = $2 AND ra.scope_type = 'space'
  AND ra.room_hub_id IS NOT NULL AND ra.deleted_at IS NULL`;

@Injectable()
export class SpaceRoomTypeormRepository extends SpaceRoomRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async roomHubIds(orgId: string, spaceId: string): Promise<string[]> {
    const rows: { room_hub_id: string }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT ra.room_hub_id FROM role_assignments ra WHERE ${ACTIVE_ROOM} ORDER BY ra.room_hub_id`,
          [orgId, spaceId],
        ),
    );
    return rows.map((r) => r.room_hub_id);
  }

  async roomHubs(
    orgId: string,
    spaceId: string,
  ): Promise<{ hubId: string; roleKey: SpaceRoleKey }[]> {
    const rows: { room_hub_id: string; role_key: SpaceRoleKey }[] =
      await runInOrganizationScope(this.dataSource, orgId, (m) =>
        m.query(
          `SELECT ra.room_hub_id, r.key AS role_key
             FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
            WHERE ${ACTIVE_ROOM} ORDER BY ra.room_hub_id`,
          [orgId, spaceId],
        ),
      );
    return rows.map((r) => ({ hubId: r.room_hub_id, roleKey: r.role_key }));
  }

  async assignRoom(
    orgId: string,
    spaceId: string,
    hubId: string,
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
                JOIN spaces s ON s.id = ra.space_id AND s.organization_id = ra.organization_id
               WHERE ra.organization_id = $1 AND ra.space_id = $2 AND ra.room_hub_id = $3
                 AND ra.scope_type = 'space' AND s.deleted_at IS NULL
               ORDER BY (ra.deleted_at IS NULL) DESC, ra.deleted_at DESC, ra.id DESC
               LIMIT 1)
           RETURNING id`,
          [orgId, spaceId, hubId, roleId, grantedBy],
        ),
      );
      if (revived.length > 0) return;
      const inserted: { id: string }[] = await m.query(
        `INSERT INTO role_assignments (role_id, room_hub_id, scope_type, organization_id, space_id, granted_by_user_id)
         SELECT $4, $3, 'space', s.organization_id, s.id, $5
           FROM spaces s
          WHERE s.id = $2 AND s.organization_id = $1 AND s.deleted_at IS NULL
         ON CONFLICT (space_id, room_hub_id)
           WHERE scope_type = 'space' AND room_hub_id IS NOT NULL AND deleted_at IS NULL
         DO UPDATE SET role_id = EXCLUDED.role_id,
                       granted_by_user_id = EXCLUDED.granted_by_user_id,
                       updated_at = now()
         RETURNING id`,
        [orgId, spaceId, hubId, roleId, grantedBy],
      );
      if (inserted.length === 0) throw spaceNotFound();
    });
  }

  async upsertHubGrant(
    orgId: string,
    spaceKeyId: string,
    hubId: string,
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
               WHERE g.organization_id = $1 AND g.space_key_id = $2 AND g.hub_id = $3
                 AND k.deleted_at IS NULL
               ORDER BY (g.deleted_at IS NULL) DESC, g.deleted_at DESC, g.id DESC
               LIMIT 1)
           RETURNING id`,
          [orgId, spaceKeyId, hubId, wrappedKey],
        ),
      );
      if (revived.length > 0) return;
      const inserted: { id: string }[] = await m.query(
        `INSERT INTO space_key_grants (organization_id, space_key_id, hub_id, wrapped_key)
         SELECT k.organization_id, k.id, $3, $4
           FROM space_keys k
          WHERE k.id = $2 AND k.organization_id = $1 AND k.deleted_at IS NULL
         ON CONFLICT (space_key_id, hub_id) WHERE hub_id IS NOT NULL AND deleted_at IS NULL
         DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key, updated_at = now()
         RETURNING id`,
        [orgId, spaceKeyId, hubId, wrappedKey],
      );
      if (inserted.length === 0) throw spaceKeyNotFound();
    });
  }

  async removeRoom(
    orgId: string,
    spaceId: string,
    hubId: string,
  ): Promise<boolean> {
    return runInOrganizationScope(this.dataSource, orgId, async (m) => {
      const roles = updatedRows(
        await m.query(
          `UPDATE role_assignments ra SET deleted_at = now(), updated_at = now()
            WHERE ${ACTIVE_ROOM} AND ra.room_hub_id = $3
           RETURNING ra.id`,
          [orgId, spaceId, hubId],
        ),
      );
      const grants = updatedRows(
        await m.query(
          `UPDATE space_key_grants g
              SET deleted_at = now(), updated_at = now()
             FROM space_keys k
            WHERE k.id = g.space_key_id AND k.organization_id = g.organization_id
              AND g.organization_id = $1 AND k.space_id = $2 AND g.hub_id = $3
              AND g.deleted_at IS NULL
           RETURNING g.id`,
          [orgId, spaceId, hubId],
        ),
      );
      return roles.length + grants.length > 0;
    });
  }

  async roomSpaceIdsOfHub(orgId: string, hubId: string): Promise<string[]> {
    const rows: { space_id: string }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT ra.space_id FROM role_assignments ra
            WHERE ra.organization_id = $1 AND ra.room_hub_id = $2
              AND ra.scope_type = 'space' AND ra.deleted_at IS NULL
           UNION
           SELECT k.space_id FROM space_key_grants g
             JOIN space_keys k ON k.id = g.space_key_id AND k.organization_id = g.organization_id
            WHERE g.organization_id = $1 AND g.hub_id = $2 AND g.deleted_at IS NULL
           ORDER BY 1`,
          [orgId, hubId],
        ),
    );
    return rows.map((r) => r.space_id);
  }

  async removeHubInOrg(orgId: string, hubId: string): Promise<string[]> {
    return runInOrganizationScope(this.dataSource, orgId, async (m) => {
      const roles = updatedRows<{ space_id: string }>(
        await m.query(
          `UPDATE role_assignments SET deleted_at = now(), updated_at = now()
            WHERE organization_id = $1 AND room_hub_id = $2
              AND scope_type = 'space' AND deleted_at IS NULL
           RETURNING space_id`,
          [orgId, hubId],
        ),
      );
      const grants = updatedRows<{ space_id: string }>(
        await m.query(
          `UPDATE space_key_grants g
              SET deleted_at = now(), updated_at = now()
             FROM space_keys k
            WHERE k.id = g.space_key_id AND k.organization_id = g.organization_id
              AND g.organization_id = $1 AND g.hub_id = $2 AND g.deleted_at IS NULL
           RETURNING k.space_id`,
          [orgId, hubId],
        ),
      );
      return distinctSorted([...roles, ...grants].map((r) => r.space_id));
    });
  }
}
