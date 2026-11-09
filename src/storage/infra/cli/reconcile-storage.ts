// Varredura do reparo do backup (índice × bucket). Uso, depois do `npm run build` (o Nest precisa do código
// compilado), com o login de RUNTIME do .env, como a API:
//   npm run storage:reconcile [-- <minutos>]     (padrão: marcas com mais de 60 min)
// Agendar 1x por dia fora da aplicação até o pg-boss entrar (CLAUDE.md, Pendências).
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../../../app.module.js';
import { ReconcileStorageUseCase } from '../../application/reconcile-storage.use-case.js';

async function main(): Promise<void> {
  const arg = process.argv[2];
  const olderThanMinutes = arg === undefined ? undefined : Number(arg);
  if (
    olderThanMinutes !== undefined &&
    (!Number.isInteger(olderThanMinutes) || olderThanMinutes < 0)
  ) {
    console.error('Usage: npm run storage:reconcile [-- <minutes>]');
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  try {
    const result = await app
      .get(ReconcileStorageUseCase)
      .execute({ olderThanMinutes });
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
}

await main();
