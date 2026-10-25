import {
  type INestApplication,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseTrustProxy } from './trust-proxy.js';
import { setupSwagger } from './swagger.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import {
  type InvalidField,
  RequestValidationError,
} from './request-validation.error.js';

function flatten(errors: ValidationError[], prefix = ''): InvalidField[] {
  const out: InvalidField[] = [];
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.constraints) {
      out.push({ field: path, messages: Object.values(e.constraints) });
    }
    if (e.children?.length) out.push(...flatten(e.children, path));
  }
  return out;
}

// Único lugar que liga pipe e filtro globais; usado por main.ts e pelos e2e.
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  const baseUrl = config
    .getOrThrow<string>('PROBLEM_TYPE_BASE_URL')
    .replace(/\/$/, '');
  // Express: decides whether X-Forwarded-For feeds req.ip (sessions' lastIp, rate-limit key).
  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', parseTrustProxy(config.get<string>('TRUST_PROXY')));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => new RequestValidationError(flatten(errors)),
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter(baseUrl));
  setupSwagger(app, config);
}
