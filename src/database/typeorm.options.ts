import type { DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from '../shared/infra/db/snake-naming.strategy.js';

export type DatabaseRole = 'app' | 'migration';

/**
 * How long a query waits for a free pool connection before failing (pg's default is 0 = forever). With a wait-forever
 * pool, code that needs a second connection while holding one (and all connections busy) hangs the whole API
 * silently; with a timeout it becomes an error (500) and the transactions holding connections roll back.
 */
export const DB_POOL_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Connections in the pool of each API instance (explicit; it was pg's default). Long work holds one connection for
 * its whole transaction (a backup confirmation copies up to 5 GiB in S3 under its locks), so the backup bounds what
 * it holds: `MAX_CONFIRM_BATCH_BYTES` per confirmation and `STORAGE_LOCK_TIMEOUT_MS` per lock wait. Changing it:
 * instances × this value must stay below the database `max_connections` (minus the owner's and the CLI's).
 */
export const DB_POOL_MAX_CONNECTIONS = 10;

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
    // Opções do pool do driver `pg`.
    extra: {
      max: DB_POOL_MAX_CONNECTIONS,
      connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
    },
  };
}
