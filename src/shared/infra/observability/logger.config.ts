import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigService } from '@nestjs/config';
import type { Options } from 'pino-http';
import { newId } from '../../domain/id.js';
import { scrubSensitive } from './sensitive-fields.js';

const VALID_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function genReqId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  const id = value && VALID_REQUEST_ID.test(value) ? value : newId();
  res.setHeader('X-Request-Id', id);
  return id;
}

export function pinoHttpOptions(config: ConfigService): Options {
  return {
    level: config.get<string>('LOG_LEVEL') ?? 'info',
    genReqId,
    // Cabeçalhos por caminho; todo o resto passa por scrubSensitive em qualquer profundidade.
    formatters: {
      // req/res (IncomingMessage/ServerResponse) ficam de fora: os serializers abaixo já escolhem os campos.
      log: ({ req, res, ...rest }) => ({
        ...scrubSensitive(rest),
        ...(req !== undefined ? { req } : {}),
        ...(res !== undefined ? { res } : {}),
      }),
    },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    // Só método, URL e id: sem corpo e sem cabeçalhos.
    serializers: {
      req: (req: { id: string; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    ...(config.get<boolean>('LOG_PRETTY') === true
      ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
      : {}),
  };
}
