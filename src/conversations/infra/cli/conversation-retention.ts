// Retenção dos assuntos (spec conversations §4.4.1): zera os corpos das mensagens, o cabeçalho e tira do bucket os
// anexos de tudo que tem lápide há mais de 30 dias (relógio do banco). Uso, depois do `npm run build`, no container:
//   npm run conversations:retention
// Conecta com o login DONO do .env (DB_USERNAME; veja `ConversationRetentionSqlStore`) só para essa rotina; o S3 vem da
// configuração da API. Agendar 1x por dia fora da aplicação, ANTES do `storage:reconcile` (que apaga o que o S3 não
// apagou desta vez), até o pg-boss entrar (CLAUDE.md, Pendências).
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module.js';
import { typeOrmOptions } from '../../../database/typeorm.options.js';
import { ObjectStore } from '../../../storage/application/ports/object-store.js';
import { ConversationRetention } from '../../application/conversation-retention.js';
import { ConversationRetentionSqlStore } from '../db/conversation-retention.sql-store.js';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  const owner = new DataSource(typeOrmOptions('migration'));
  try {
    await owner.initialize();
    const result = await new ConversationRetention(
      new ConversationRetentionSqlStore(owner),
      app.get(ObjectStore),
    ).execute();
    console.log(JSON.stringify(result));
  } finally {
    if (owner.isInitialized) await owner.destroy();
    await app.close();
  }
}

await main();
