import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { adminDataSource, createTestApp } from '../setup/test-app.js';

describe('database runtime role (e2e)', () => {
  let app: INestApplication;
  let appDs: DataSource;
  let admin: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    appDs = app.get(DataSource);
    admin = await adminDataSource();
    await admin.query('DROP TABLE IF EXISTS role_probe');
    await admin.query('CREATE TABLE role_probe (id int PRIMARY KEY)');
    await admin.query('INSERT INTO role_probe VALUES (1)');
  });

  afterAll(async () => {
    await admin.query('DROP TABLE IF EXISTS role_probe');
    await admin.destroy();
    await app.close();
  });

  it('app connects as a non-superuser role without BYPASSRLS', async () => {
    const rows = await appDs.query(
      'SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows).toEqual([
      { current_user: 'vaulter_app', rolsuper: false, rolbypassrls: false },
    ]);
  });

  it('audit_logs is append-only for the app role: UPDATE and DELETE are permission denied', async () => {
    // Privilege check, before RLS: denied even with no organization in context (no rows visible).
    await expect(
      appDs.query(`UPDATE audit_logs SET action = 'tampered'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(appDs.query('DELETE FROM audit_logs')).rejects.toMatchObject({
      code: '42501',
    });
    const [privs] = await appDs.query(
      `SELECT has_table_privilege('audit_logs', 'INSERT') AS ins,
              has_table_privilege('audit_logs', 'SELECT') AS sel,
              has_table_privilege('audit_logs', 'UPDATE') AS upd,
              has_table_privilege('audit_logs', 'DELETE') AS del`,
    );
    expect(privs).toEqual({ ins: true, sel: true, upd: false, del: false });
  });

  it('app role cannot DELETE', async () => {
    await expect(appDs.query('DELETE FROM role_probe')).rejects.toMatchObject({
      code: '42501',
    });
  });
});
