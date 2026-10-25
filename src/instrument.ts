// Deve ser o PRIMEIRO import de main.ts. O ConfigModule só carrega o .env depois, então carregamos aqui.
import { existsSync } from 'node:fs';
import * as Sentry from '@sentry/nestjs';
import { sentryOptions } from './shared/infra/observability/sentry.config.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

Sentry.init(sentryOptions(process.env));
