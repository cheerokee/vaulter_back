import type { IncomingMessage, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { isUuidV7 } from '../../domain/id.js';
import { genReqId, REDACT_PATHS } from './logger.config.js';

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

  it('redacts sensitive values in log output', () => {
    let out = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const logger = pino(
      { redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
      stream,
    );
    logger.info(
      {
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1' } },
        res: { headers: { 'set-cookie': 'sid=2' } },
        user: { authProof: 'proof-secret', refresh_token: 'rt-secret' },
      },
      'hi',
    );
    for (const secret of [
      'Bearer abc',
      'sid=1',
      'sid=2',
      'proof-secret',
      'rt-secret',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[REDACTED]');
  });
});
