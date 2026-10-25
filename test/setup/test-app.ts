import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { typeOrmOptions } from '../../src/database/typeorm.options.js';

let admin: DataSource | undefined;

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication();
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
