import type { DataSource } from 'typeorm';
import { adminDataSource, resetDatabase } from '../setup/test-app.js';
import {
  FACTORY_ROLES,
  PERMISSIONS,
  PERMISSION_DEPENDENCIES,
} from '../../src/organizations/domain/rbac-catalog.js';
import { isUuidV7 } from '../../src/shared/domain/id.js';

describe('RBAC catalog (migration data)', () => {
  let db: DataSource;
  beforeAll(async () => {
    db = await adminDataSource();
  });

  it('has exactly the permissions of the domain catalog, with ids v7 and names', async () => {
    const rows: {
      id: string;
      key: string;
      scope_type: string;
      name: string;
      description: string;
    }[] = await db.query(`SELECT * FROM permissions WHERE deleted_at IS NULL`);
    expect(Object.fromEntries(rows.map((r) => [r.key, r.scope_type]))).toEqual(
      PERMISSIONS,
    );
    for (const r of rows) {
      expect(isUuidV7(r.id)).toBe(true);
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
    }
  });

  it('has exactly the factory roles with null organization and the table permissions', async () => {
    const roles: { id: string; key: string; organization_id: string | null }[] =
      await db.query(
        `SELECT id, key, organization_id FROM roles WHERE deleted_at IS NULL`,
      );
    expect(roles.map((r) => r.key).sort()).toEqual(
      Object.keys(FACTORY_ROLES).sort(),
    );
    for (const r of roles) {
      expect(r.organization_id).toBeNull();
      expect(isUuidV7(r.id)).toBe(true);
    }
    const links: { role_key: string; permission_key: string }[] =
      await db.query(
        `SELECT r.key AS role_key, p.key AS permission_key
           FROM role_permission rp
           JOIN roles r ON r.id = rp.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.deleted_at IS NULL`,
      );
    const actual: Record<string, string[]> = {};
    for (const k of Object.keys(FACTORY_ROLES)) actual[k] = [];
    for (const l of links) actual[l.role_key].push(l.permission_key);
    for (const k of Object.keys(actual)) {
      expect(actual[k].sort((a, b) => a.localeCompare(b))).toEqual(
        [...FACTORY_ROLES[k as never]].sort((a, b) => a.localeCompare(b)),
      );
    }
  });

  it('role scope matches the key prefix', async () => {
    const rows: { key: string; scope_type: string }[] = await db.query(
      `SELECT key, scope_type FROM roles`,
    );
    const scopeOf = (k: string) =>
      k.startsWith('org_')
        ? 'organization'
        : k.startsWith('space_')
          ? 'space'
          : 'hub';
    for (const r of rows) expect(r.scope_type).toBe(scopeOf(r.key));
  });

  it('has the permission dependencies', async () => {
    const rows: { permission_key: string; requires_key: string }[] =
      await db.query(
        `SELECT p.key AS permission_key, q.key AS requires_key
           FROM permission_dependency d
           JOIN permissions p ON p.id = d.permission_id
           JOIN permissions q ON q.id = d.requires_permission_id
          WHERE d.deleted_at IS NULL`,
      );
    expect(
      Object.fromEntries(rows.map((r) => [r.permission_key, r.requires_key])),
    ).toEqual(PERMISSION_DEPENDENCIES);
    expect(rows).toHaveLength(2);
  });

  it('syncable catalog tables have sync_version', async () => {
    for (const t of [
      'permissions',
      'permission_dependency',
      'roles',
      'role_permission',
    ]) {
      const rows: { sync_version: string }[] = await db.query(
        `SELECT sync_version FROM ${t}`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(BigInt(r.sync_version) > 0n).toBe(true);
    }
  });

  it('keeps factory role keys unique', async () => {
    await expect(
      db.query(
        `INSERT INTO roles (scope_type, key, name) VALUES ('hub', 'hub_room', 'x')`,
      ),
    ).rejects.toThrow();
  });

  it('survives resetDatabase (catalog is re-seeded)', async () => {
    await resetDatabase();
    const [{ n }]: { n: string }[] = await db.query(
      `SELECT count(*) AS n FROM permissions`,
    );
    expect(Number(n)).toBe(16);
  });
});
