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

  it('app role cannot DELETE', async () => {
    await expect(appDs.query('DELETE FROM role_probe')).rejects.toMatchObject({
      code: '42501',
    });
  });
});
