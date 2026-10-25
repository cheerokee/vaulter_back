import './instrument.js';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './shared/infra/http/configure-app.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);
  // SIGTERM/SIGINT passam por app.close(): o HTTP para de aceitar e só depois os onApplicationShutdown rodam
  // (ex.: o pool do Argon2 é destruído sem matar logins em andamento).
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
