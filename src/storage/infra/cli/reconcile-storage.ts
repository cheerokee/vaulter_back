// Varredura do reparo do bucket (índice × S3) sob demanda: a mesma da tarefa diária do pg-boss (`storage.reconcile`,
// 04:00 UTC, veja `StorageReconciliation`). Útil para rodar fora de hora ou com outra idade das marcas. Uso, depois do
// `npm run build` (o Nest precisa do código compilado), com o login de RUNTIME do .env, como a API:
//   npm run storage:reconcile [-- <minutos>]     (padrão: marcas com mais de 60 min)
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../../../app.module.js';
import { StorageReconciliation } from '../../application/storage-reconcile.job.js';

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
  // A one-shot process: never fetch jobs of the API's queues (the .env does not override a variable already set).
  process.env.JOB_WORKERS_ENABLED = 'false';
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  try {
    const result = await app.get(StorageReconciliation).run(olderThanMinutes);
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
}

await main();
