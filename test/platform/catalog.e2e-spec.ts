import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DEFAULT_KDF_PARAMS } from '../../src/identity/domain/kdf-params.js';
import { User } from '../../src/identity/domain/user.js';
import { UserRepository } from '../../src/identity/domain/user.repository.js';
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
} from '../../src/platform/domain/platform-catalog.js';
import { isUuidV7 } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { testRecoveryFields } from '../support/client-crypto.js';
import { insertHub } from '../support/spaces-db.js';

const b64 = (n: number, first?: number) => {
  const b = Buffer.alloc(n, 0xab);
  if (first !== undefined) b[0] = first;
  return b.toString('base64url');
};

describe('platform catalog (migration data)', () => {
  let app: INestApplication;
  let runtime: DataSource;
  let db: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    runtime = app.get(DataSource);
    db = await adminDataSource();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  it('has exactly the platform permissions of the domain catalog', async () => {
    const rows: { id: string; key: string }[] = await db.query(
      `SELECT id, key FROM platform_permissions WHERE deleted_at IS NULL`,
    );
    expect(rows.map((r) => r.key).sort()).toEqual(
      [...PLATFORM_PERMISSIONS].sort(),
    );
    for (const r of rows) expect(isUuidV7(r.id)).toBe(true);
  });

  it('has exactly the platform roles, names and permissions of the domain catalog', async () => {
    const roles: { id: string; key: string; name: string }[] = await db.query(
      `SELECT id, key, name FROM platform_roles WHERE deleted_at IS NULL`,
    );
    expect(Object.fromEntries(roles.map((r) => [r.key, r.name]))).toEqual(
      Object.fromEntries(
        Object.entries(PLATFORM_ROLES).map(([k, v]) => [k, v.name]),
      ),
    );
    for (const r of roles) expect(isUuidV7(r.id)).toBe(true);

    const links: { role_key: string; permission_key: string }[] =
      await db.query(
        `SELECT r.key AS role_key, p.key AS permission_key
           FROM platform_role_permission rp
           JOIN platform_roles r ON r.id = rp.platform_role_id
           JOIN platform_permissions p ON p.id = rp.platform_permission_id
          WHERE rp.deleted_at IS NULL`,
      );
    const actual: Record<string, string[]> = {};
    for (const k of Object.keys(PLATFORM_ROLES)) actual[k] = [];
    for (const l of links) actual[l.role_key]!.push(l.permission_key);
    for (const [k, role] of Object.entries(PLATFORM_ROLES)) {
      expect(actual[k]!.sort()).toEqual([...role.permissions].sort());
    }
  });

  it('platform tables have no sync_version', async () => {
    const rows: { table_name: string }[] = await db.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name LIKE '%platform%' AND column_name = 'sync_version'`,
    );
    expect(rows).toEqual([]);
  });

  describe('runtime login permissions', () => {
    const makeUser = async (email: string): Promise<string> => {
      const user = User.register({
        name: 'staff',
        email,
        authHash: '$argon2id$v=19$m=19456,t=2,p=1$fake',
        kdfSalt: b64(16),
        kdfParams: { ...DEFAULT_KDF_PARAMS },
        publicKey: b64(32),
        encryptedPrivateKey: b64(73, 0x01),
        ...testRecoveryFields(),
        now: new Date(),
      });
      await app.get(UserRepository, { strict: false }).create(user);
      return user.id;
    };

    it('runs as the runtime role', async () => {
      const [{ u }] = (await runtime.query('SELECT current_user AS u')) as {
        u: string;
      }[];
      expect(u).toBe(process.env.DB_APP_USERNAME);
    });

    it('reads the catalog but cannot write it', async () => {
      const rows: unknown[] = await runtime.query(
        `SELECT 1 FROM platform_role_permission`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const sql of [
        `INSERT INTO platform_roles (key, name) VALUES ('x', 'x')`,
        `INSERT INTO platform_permissions (key) VALUES ('x')`,
        `UPDATE platform_roles SET name = 'x'`,
        `UPDATE platform_role_permission SET deleted_at = now()`,
      ]) {
        await expect(runtime.query(sql)).rejects.toMatchObject({
          code: '42501',
        });
      }
    });

    it('can insert into platform_audit_logs but not update or delete', async () => {
      await runtime.query(
        `INSERT INTO platform_audit_logs (action, result) VALUES ('platform.role.granted', 'success')`,
      );
      await expect(
        runtime.query(`UPDATE platform_audit_logs SET action = 'x'`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtime.query(`DELETE FROM platform_audit_logs`),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('can insert and update user_platform_role, but not delete', async () => {
      const userId = await makeUser('staff@x.com');
      const roleId = (
        (await runtime.query(
          `SELECT id FROM platform_roles WHERE key = 'platform_support'`,
        )) as { id: string }[]
      )[0]!.id;
      await runtime.query(
        `INSERT INTO user_platform_role (user_id, platform_role_id) VALUES ($1, $2)`,
        [userId, roleId],
      );
      await runtime.query(
        `UPDATE user_platform_role SET deleted_at = now() WHERE user_id = $1`,
        [userId],
      );
      await expect(
        runtime.query(`DELETE FROM user_platform_role`),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('support requests: targets are checked by type, and the runtime cannot delete', async () => {
      const userId = await makeUser('support@x.com');
      const insert = (
        type: string,
        hubId: string | null,
        orgId: string | null,
        targetUserId: string | null,
      ) =>
        runtime.query(
          `INSERT INTO platform_support_requests
             (type, status, requested_by_user_id, target_hub_id, target_organization_id, target_user_id,
              reason, evidence, expires_at)
           VALUES ($1, 'pending', $2, $3, $4, $5, 'reason', 'evidence', now() + interval '7 days')`,
          [type, userId, hubId, orgId, targetUserId],
        );
      const hubId = await insertHub(userId, {
        signingPublicKey: b64(32),
        encryptionPublicKey: b64(32),
      });
      const [{ id: orgId }] = (await db.query(
        `INSERT INTO organizations (name) VALUES ('Org') RETURNING id`,
      )) as { id: string }[];
      // os dois alvos válidos passam
      await insert('hub_force_deregister', hubId, null, null);
      await insert('org_appoint_admin', null, orgId!, userId);
      // nomeação sem organização ou com Hub; desregistro sem Hub ou com outro alvo; tipo desconhecido
      const invalid: [string, string | null, string | null, string | null][] = [
        ['org_appoint_admin', null, null, userId],
        ['org_appoint_admin', hubId, orgId!, userId],
        ['hub_force_deregister', null, null, null],
        ['hub_force_deregister', hubId, null, userId],
        ['hub_force_deregister', hubId, orgId!, null],
        ['other', hubId, null, null],
      ];
      for (const args of invalid) {
        await expect(insert(...args)).rejects.toMatchObject({ code: '23514' });
      }
      await expect(
        runtime.query(
          `INSERT INTO platform_support_requests
             (type, status, requested_by_user_id, target_user_id, reason, evidence, expires_at)
           VALUES ('org_appoint_admin', 'unknown', $1, $1, 'r', 'e', now())`,
          [userId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        runtime.query(`DELETE FROM platform_support_requests`),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});
