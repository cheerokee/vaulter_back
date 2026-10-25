import type { EntityManager } from 'typeorm';
import type { OrgRoleKey } from '../../domain/membership.js';

// Id do papel de fábrica de organização (org_admin, org_member). Papéis de fábrica são visíveis em qualquer
// contexto (policy roles_read).
export async function orgFactoryRoleId(
  manager: EntityManager,
  key: OrgRoleKey,
): Promise<string> {
  const rows: { id: string }[] = await manager.query(
    `SELECT id FROM roles
      WHERE key = $1 AND organization_id IS NULL AND scope_type = 'organization' AND deleted_at IS NULL`,
    [key],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`Factory role ${key} is missing from the catalog.`);
  return id;
}
