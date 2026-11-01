import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource, type EntityManager } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import {
  HubRoleRepository,
  type HubRoleAssignment,
} from '../../domain/hub-role.repository.js';
import {
  ASSIGNABLE_HUB_ROLES,
  type AssignableHubRole,
} from '../../domain/hub-roles.js';
import { updatedRows } from './db-helpers.js';

// Papéis de Hub atribuíveis em role_assignments (scope_type = 'hub', hub_id, organization_id nulo). Contexto
// ambiente: o dono do Hub (`app.user_id`) lê e grava; o próprio Hub (`app.hub_id`, também usado pelas cascatas
// que agem sobre um Hub) lê e atualiza. hub_owner e hub_room (sistema) nunca passam por aqui.
const ACTIVE = `ra.scope_type = 'hub' AND ra.hub_id = $1 AND ra.user_id IS NOT NULL AND ra.deleted_at IS NULL`;

@Injectable()
export class HubRoleTypeormRepository extends HubRoleRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  private get manager(): EntityManager {
    return currentManager(this.dataSource);
  }

  // Papéis de fábrica são visíveis em qualquer contexto (policy roles_read).
  private async roleIds(): Promise<Map<AssignableHubRole, string>> {
    const rows: { id: string; key: AssignableHubRole }[] =
      await this.manager.query(
        `SELECT id, key FROM roles
          WHERE organization_id IS NULL AND scope_type = 'hub' AND key = ANY($1) AND deleted_at IS NULL`,
        [[...ASSIGNABLE_HUB_ROLES]],
      );
    const map = new Map(rows.map((r) => [r.key, r.id]));
    for (const key of ASSIGNABLE_HUB_ROLES) {
      if (!map.has(key)) {
        throw new Error(`Factory role ${key} is missing from the catalog.`);
      }
    }
    return map;
  }

  // Uma linha por (Hub, pessoa) para sempre: revive a lápide (ou troca o papel da ativa); sem linha, insere. O
  // ON CONFLICT cobre a corrida; o WHERE do DO UPDATE nunca rebaixa um papel de sistema (hub_owner).
  async assign(assignment: HubRoleAssignment): Promise<void> {
    const ids = await this.roleIds();
    const roleId = ids.get(assignment.roleKey)!;
    const assignable = [...ids.values()];
    const revived = updatedRows(
      await this.manager.query(
        `UPDATE role_assignments SET role_id = $3, deleted_at = NULL, updated_at = now()
          WHERE id = (
            SELECT ra.id FROM role_assignments ra
             WHERE ra.scope_type = 'hub' AND ra.hub_id = $1 AND ra.user_id = $2 AND ra.role_id = ANY($4)
             ORDER BY (ra.deleted_at IS NULL) DESC, ra.deleted_at DESC, ra.id DESC
             LIMIT 1)
         RETURNING id`,
        [assignment.hubId, assignment.userId, roleId, assignable],
      ),
    );
    if (revived.length > 0) return;
    const inserted: { id: string }[] = await this.manager.query(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, hub_id)
       VALUES ($3, $2, 'hub', $1)
       ON CONFLICT (hub_id, user_id) WHERE scope_type = 'hub' AND deleted_at IS NULL
       DO UPDATE SET role_id = EXCLUDED.role_id, updated_at = now()
       WHERE role_assignments.role_id = ANY($4)
       RETURNING id`,
      [assignment.hubId, assignment.userId, roleId, assignable],
    );
    if (inserted.length === 0) {
      throw new Error(
        'HubRoleRepository.assign: the user holds a system hub role on this hub.',
      );
    }
  }

  async remove(hubId: string, userId: string): Promise<void> {
    if (!validate(hubId) || !validate(userId)) return;
    const assignable = [...(await this.roleIds()).values()];
    await this.manager.query(
      `UPDATE role_assignments ra SET deleted_at = now(), updated_at = now()
        WHERE ${ACTIVE} AND ra.user_id = $2 AND ra.role_id = ANY($3)`,
      [hubId, userId, assignable],
    );
  }

  async list(hubId: string): Promise<HubRoleAssignment[]> {
    if (!validate(hubId)) return [];
    const rows: { hub_id: string; user_id: string; key: AssignableHubRole }[] =
      await this.manager.query(
        `SELECT ra.hub_id, ra.user_id, r.key FROM role_assignments ra
           JOIN roles r ON r.id = ra.role_id
          WHERE ${ACTIVE} AND r.key = ANY($2)
          ORDER BY ra.user_id`,
        [hubId, [...ASSIGNABLE_HUB_ROLES]],
      );
    return rows.map((r) => ({
      hubId: r.hub_id,
      userId: r.user_id,
      roleKey: r.key,
    }));
  }

  // user_organization só mostra outra pessoa no escopo da organização: confere as organizações vinculadas
  // (aprovadas) uma a uma, cada uma no próprio escopo, e só então grava as lápides. Precisa do contexto do dono
  // ou do Hub (`app.hub_id`) para ver vínculos e atribuições.
  async removeUsersWithoutLinkedOrg(hubId: string): Promise<string[]> {
    if (!validate(hubId)) return [];
    const assignable = [...(await this.roleIds()).values()];
    const assigned: { user_id: string }[] = await this.manager.query(
      `SELECT DISTINCT ra.user_id FROM role_assignments ra
        WHERE ${ACTIVE} AND ra.role_id = ANY($2)`,
      [hubId, assignable],
    );
    if (assigned.length === 0) return [];
    const userIds = assigned.map((r) => r.user_id);
    const orgs: { organization_id: string }[] = await this.manager.query(
      `SELECT organization_id FROM hub_organization
        WHERE hub_id = $1 AND status = 'approved' AND deleted_at IS NULL
        ORDER BY organization_id`,
      [hubId],
    );
    const keep = new Set<string>();
    for (const { organization_id: orgId } of orgs) {
      const rows: { user_id: string }[] = await runInOrganizationScope(
        this.dataSource,
        orgId,
        (m) =>
          m.query(
            `SELECT user_id FROM user_organization
              WHERE organization_id = $1 AND user_id = ANY($2) AND deleted_at IS NULL`,
            [orgId, userIds],
          ),
      );
      for (const r of rows) keep.add(r.user_id);
    }
    const drop = userIds.filter((u) => !keep.has(u));
    if (drop.length === 0) return [];
    const removed = updatedRows<{ user_id: string }>(
      await this.manager.query(
        `UPDATE role_assignments ra SET deleted_at = now(), updated_at = now()
          WHERE ${ACTIVE} AND ra.role_id = ANY($2) AND ra.user_id = ANY($3)
         RETURNING ra.user_id`,
        [hubId, assignable, drop],
      ),
    );
    return [...new Set(removed.map((r) => r.user_id))].sort();
  }
}
