import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/shared/infra/http/configure-app.js';
import { seedRbacCatalog } from '../../src/database/rbac-catalog-seed.js';
import { typeOrmOptions } from '../../src/database/typeorm.options.js';

let admin: DataSource | undefined;

/** `env` patches ConfigService.get/getOrThrow for those keys only; defaults stay untouched. */
export async function createTestApp(
  options: { env?: Record<string, string> } = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
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

// Esvazia todas as tabelas, exceto o histórico de migrations, e repõe o catálogo RBAC.
export async function resetDatabase(): Promise<void> {
  const ds = await adminDataSource();
  const tables: { tablename: string }[] = await ds.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'`,
  );
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await ds.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  // O catálogo RBAC é dado de migration: volta com os mesmos ids após o reset.
  if (list.includes('"permissions"')) await seedRbacCatalog(ds);
}
