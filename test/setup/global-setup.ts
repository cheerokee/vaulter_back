/// <reference types="vite/client" />
import { DataSource, type DataSourceOptions } from 'typeorm';
import { typeOrmOptions } from '../../src/database/typeorm.options.js';

// Roda uma vez antes dos e2e: cria o banco de teste (se faltar), garante extensão e login de runtime
// (mesmo SQL do 02-app-role.sh) e aplica as migrations com o papel dono.
const migrationModules = import.meta.glob(
  '../../src/database/migrations/*.ts',
  {
    eager: true,
  },
) as Record<string, Record<string, new () => unknown>>;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export default async function globalSetup(): Promise<void> {
  const database = process.env.DB_DATABASE;
  if (!database) throw new Error('DB_DATABASE must be set for e2e tests');
  const appUser = process.env.DB_APP_USERNAME;
  const appPassword = process.env.DB_APP_PASSWORD;
  if (!appUser || !appPassword) {
    throw new Error(
      'DB_APP_USERNAME and DB_APP_PASSWORD must be set for e2e tests',
    );
  }

  const baseOptions = typeOrmOptions('migration') as DataSourceOptions & {
    type: 'postgres';
  };
  const admin = new DataSource({ ...baseOptions, database: 'postgres' });
  await admin.initialize();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [database],
    );
    if (exists.length === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdent(database)}`);
    }
    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
          CREATE ROLE app_runtime NOLOGIN NOBYPASSRLS;
        END IF;
      END
      $$
    `);
    const login = await admin.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [appUser],
    );
    if (login.length === 0) {
      const passwordLiteral = `'${appPassword.replaceAll("'", "''")}'`;
      await admin.query(
        `CREATE ROLE ${quoteIdent(appUser)} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${passwordLiteral}`,
      );
    }
    await admin.query(`GRANT app_runtime TO ${quoteIdent(appUser)}`);
  } finally {
    await admin.destroy();
  }

  const migrator = new DataSource({
    ...baseOptions,
    migrations: Object.values(migrationModules).flatMap((mod) =>
      Object.values(mod),
    ),
  });
  await migrator.initialize();
  try {
    await migrator.query('CREATE EXTENSION IF NOT EXISTS vector');
    await migrator.runMigrations();
  } finally {
    await migrator.destroy();
  }
}
