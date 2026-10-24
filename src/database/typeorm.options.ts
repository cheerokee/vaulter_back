import type { DataSourceOptions } from 'typeorm';

// Conexão compartilhada entre a aplicação Nest e o CLI de migrations (data-source.ts).
// Lê process.env na hora da chamada, depois que o .env já foi carregado.
export function typeOrmOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    // Schema só muda via migrations.
    synchronize: false,
  };
}
