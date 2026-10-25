import type { IncomingMessage, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { isUuidV7 } from '../../domain/id.js';
import { ConfigService } from '@nestjs/config';
import { genReqId, pinoHttpOptions } from './logger.config.js';

function fakes(header?: string) {
  const headers: Record<string, string> = {};
  const req = {
    headers: header === undefined ? {} : { 'x-request-id': header },
  } as unknown as IncomingMessage;
  const res = {
    setHeader: (k: string, v: string) => (headers[k] = v),
  } as unknown as ServerResponse;
  return { req, res, headers };
}

describe('logger config', () => {
  it('reuses a valid incoming request id and echoes it', () => {
    const { req, res, headers } = fakes('abc-123');
    expect(genReqId(req, res)).toBe('abc-123');
    expect(headers['X-Request-Id']).toBe('abc-123');
  });

  it('generates a v7 id for an invalid or missing one', () => {
    for (const h of ['bad id!', 'x'.repeat(65), undefined]) {
      const { req, res, headers } = fakes(h);
      const id = genReqId(req, res);
      expect(isUuidV7(id)).toBe(true);
      expect(headers['X-Request-Id']).toBe(id);
    }
  });

  describe('redaction', () => {
    function capture() {
      let out = '';
      const stream = new Writable({
        write(chunk, _enc, cb) {
          out += chunk.toString();
          cb();
        },
      });
      const opts = pinoHttpOptions(
        new ConfigService({ LOG_LEVEL: 'info', LOG_PRETTY: false }),
      );
      const logger = pino(
        { redact: opts.redact, formatters: opts.formatters },
        stream,
      );
      return { logger, output: () => out };
    }

    it.each([
      ['top-level key', { authProof: 'SECRET1' }],
      ['top-level refreshToken', { refreshToken: 'SECRET1' }],
      ['depth 1', { user: { refresh_token: 'SECRET1' } }],
      ['depth 3', { body: { user: { authProof: 'SECRET1' } } }],
      ['deep error response', { err: { response: { wrappedKey: 'SECRET1' } } }],
      ['capitalized Authorization', { Authorization: 'Bearer SECRET1' }],
      ['array of objects', { items: [{ ok: 1 }, { kdfSalt: 'SECRET1' }] }],
      ['set-cookie', { headers: { 'Set-Cookie': 'SECRET1' } }],
    ])('never writes the secret: %s', (_name, payload) => {
      const { logger, output } = capture();
      logger.info(payload, 'hi');
      expect(output()).not.toContain('SECRET1');
      expect(output()).toContain('[REDACTED]');
    });

    it('redacts request and response header paths', () => {
      const { logger, output } = capture();
      logger.info(
        {
          req: {
            headers: { authorization: 'Bearer SECRET1', cookie: 'SECRET2' },
          },
          res: { headers: { 'set-cookie': 'SECRET3' } },
        },
        'hi',
      );
      for (const s of ['SECRET1', 'SECRET2', 'SECRET3']) {
        expect(output()).not.toContain(s);
      }
    });

    it('keeps non-sensitive fields', () => {
      const { logger, output } = capture();
      logger.info({ userId: 'u1', nested: { n: 2 } }, 'hi');
      expect(output()).toContain('u1');
    });
  });
});
