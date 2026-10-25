import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/shared/infra/http/configure-app.js';
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
    const { get, getOrThrow } = config;
    const patch = <T>(orig: (k: string) => T) =>
      function (this: ConfigService, key: string): T {
        return key in env ? (env[key] as T) : orig.call(this, key);
      };
    config.get = patch(get.bind(config)) as typeof config.get;
    config.getOrThrow = patch(
      getOrThrow.bind(config),
    ) as typeof config.getOrThrow;
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

// Esvazia todas as tabelas, exceto o histórico de migrations.
export async function resetDatabase(): Promise<void> {
  const ds = await adminDataSource();
  const tables: { tablename: string }[] = await ds.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'`,
  );
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await ds.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
