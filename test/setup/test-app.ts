import type { INestApplication, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/shared/infra/http/configure-app.js';
import { typeOrmOptions } from '../../src/database/typeorm.options.js';
import { assertNoPendingSyncRows } from './commit-order-check.js';

let admin: DataSource | undefined;

/**
 * `env` patches ConfigService.get/getOrThrow for those keys only; defaults stay untouched. `controllers` adds
 * test-only controllers next to AppModule (the global guards and filters apply to them as to any route).
 */
export async function createTestApp(
  options: { env?: Record<string, string>; controllers?: Type[] } = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  }).compile();
  const env = options.env;
  if (env) {
    const config = moduleRef.get(ConfigService);
    const origGet = config.get.bind(config) as (
      key: string,
      ...rest: unknown[]
    ) => unknown;
    const origGetOrThrow = config.getOrThrow.bind(config) as (
      key: string,
      ...rest: unknown[]
    ) => unknown;
    config.get = ((key: string, ...rest: unknown[]) =>
      key in env ? env[key] : origGet(key, ...rest)) as typeof config.get;
    config.getOrThrow = ((key: string, ...rest: unknown[]) =>
      key in env
        ? env[key]
        : origGetOrThrow(key, ...rest)) as typeof config.getOrThrow;
  }
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);
  await app.init();
  return app;
}

// Conexão do papel dono no banco de teste (ignora RLS e pode DELETE/TRUNCATE).
export async function adminDataSource(): Promise<DataSource> {
  if (!admin || !admin.isInitialized) {
    admin = new DataSource(typeOrmOptions('migration'));
    await admin.initialize();
  }
  return admin;
}

// Catálogos (RBAC e plataforma) são dado de migration: o reset os guarda antes de truncar e os repõe iguais (mesmos
// ids) depois. Ordem respeita as FKs; de roles só voltam os papéis de fábrica.
const CATALOG_TABLES: [table: string, where: string][] = [
  ['permissions', 'true'],
  ['permission_dependency', 'true'],
  ['roles', '"organization_id" IS NULL'],
  ['role_permission', 'true'],
  ['platform_roles', 'true'],
  ['platform_permissions', 'true'],
  ['platform_role_permission', 'true'],
];
let catalogSnapshot: Record<string, unknown[]> | undefined;

// Esvazia todas as tabelas, exceto o histórico de migrations, e repõe os catálogos.
export async function resetDatabase(): Promise<void> {
  const ds = await adminDataSource();
  const tables: { tablename: string }[] = await ds.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'`,
  );
  if (tables.length === 0) return;
  // What the previous spec file left behind is checked before it is truncated.
  await assertNoPendingSyncRows(
    ds,
    'resetDatabase (rows left by the previous spec file)',
  );
  const names = new Set(tables.map((t) => t.tablename));
  const catalog = CATALOG_TABLES.filter(([t]) => names.has(t));
  if (!catalogSnapshot) {
    catalogSnapshot = {};
    for (const [t, where] of catalog) {
      catalogSnapshot[t] = await ds.query(
        `SELECT * FROM "${t}" WHERE ${where}`,
      );
    }
    // Snapshot vazio repõe um catálogo vazio para sempre (reset rodou antes do seed?): falha alto.
    if (names.has('permissions') && !catalogSnapshot.permissions?.length) {
      catalogSnapshot = undefined;
      throw new Error(
        'resetDatabase: the RBAC catalog snapshot is empty (permissions); migrations did not seed it.',
      );
    }
    if (
      names.has('platform_permissions') &&
      !catalogSnapshot.platform_permissions?.length
    ) {
      catalogSnapshot = undefined;
      throw new Error(
        'resetDatabase: the platform catalog snapshot is empty (platform_permissions); migrations did not seed it.',
      );
    }
  }
  const list = [...names].map((t) => `"${t}"`).join(', ');
  await ds.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  for (const [t] of catalog) {
    await ds.query(
      `INSERT INTO "${t}" SELECT * FROM jsonb_populate_recordset(null::"${t}", $1::jsonb)`,
      [JSON.stringify(catalogSnapshot[t])],
    );
  }
}
