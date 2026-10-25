import type { DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from '../shared/infra/db/snake-naming.strategy.js';

export type DatabaseRole = 'app' | 'migration';

// Conexão compartilhada entre a aplicação Nest, o CLI de migrations (data-source.ts) e os testes.
// - 'app': papel de runtime (DB_APP_*), sem superusuário e sem BYPASSRLS, para o RLS valer de verdade;
// - 'migration': papel dono do banco (DB_*), usado por migrations, CLI e pelo setup dos testes.
// Lê process.env na hora da chamada, depois que o .env já foi carregado.
export function typeOrmOptions(role: DatabaseRole): DataSourceOptions {
  const isApp = role === 'app';
  return {
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: isApp ? process.env.DB_APP_USERNAME : process.env.DB_USERNAME,
    password: isApp ? process.env.DB_APP_PASSWORD : process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    // Schema só muda via migrations.
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  };
}
