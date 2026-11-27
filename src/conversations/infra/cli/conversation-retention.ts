// Retenção dos assuntos (spec conversations §4.4.1) sob demanda: zera os corpos das mensagens, o cabeçalho e tira do
// bucket os anexos de tudo que tem lápide há mais de 30 dias (relógio do banco). A tarefa diária do pg-boss
// (`conversations.retention`, 02:00 UTC) já roda; este CLI é para rodar fora de hora. Uso, depois do `npm run build`, no
// container:
//   npm run conversations:retention
// Login de runtime, no contexto de confiança `app.conversation_retention` (veja `ConversationRetentionSqlStore`).
// Sai com código 1 quando algum assunto falhou.
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../../../app.module.js';
import { ConversationRetention } from '../../application/conversation-retention.js';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  // A one-shot process: never fetch jobs of the API's queues.
  process.env.JOB_WORKERS_ENABLED = 'false';
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  try {
    const result = await app.get(ConversationRetention).execute();
    console.log(JSON.stringify(result));
    // Some conversation could not be purged (logged): whoever ran it must see the failure.
    if (result.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

await main();
