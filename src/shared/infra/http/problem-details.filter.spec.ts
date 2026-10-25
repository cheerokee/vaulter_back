import type { ArgumentsHost } from '@nestjs/common';
import { HttpException, Logger, NotFoundException } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { QueryFailedError } from 'typeorm';
import {
  ConflictError,
  DomainError,
  DomainValidationError,
  HubOfflineError,
  NotFoundError,
  PermissionDeniedError,
  UnauthenticatedError,
} from '../../domain/errors.js';
import { LoadSheddingException } from './load-shedding.exception.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { RequestValidationError } from './request-validation.error.js';

vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

const BASE = 'https://errors.example.invalid';

function run(exception: unknown, reqId: string | undefined = 'req-1') {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: reqId }),
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter(BASE).catch(exception, host);
  return res;
}

describe('ProblemDetailsFilter', () => {
  it('does not trust an exposed error without a string type', () => {
    const res = run(
      Object.assign(new Error('x'), { status: 418, expose: true }),
    );
    expect(res.statusCode).toBe(500);
  });

  it('maps exposed http-errors from body-parser (413) to problem+json, not 500', () => {
    const err = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
    });
    const res = run(err);
    expect(res.statusCode).toBe(413);
    expect(res.body.type).toBe(`${BASE}/payload-too-large`);
  });

  it('maps DomainValidationError to 422 problem+json with stable type', () => {
    const res = run(
      new DomainValidationError('kdf-params-out-of-range', 'bad kdf'),
    );
    expect(res.statusCode).toBe(422);
    expect(res.headers['Content-Type']).toBe('application/problem+json');
    expect(res.body.type).toBe(`${BASE}/kdf-params-out-of-range`);
    expect(res.body.status).toBe(422);
    expect(res.body.detail).toBe('bad kdf');
    expect(res.body.requestId).toBe('req-1');
  });

  it.each([
    [new NotFoundError('user-not-found', 'x'), 404, 'user-not-found'],
    [new PermissionDeniedError('forbidden', 'x'), 403, 'forbidden'],
    [new ConflictError('email-taken', 'x'), 409, 'email-taken'],
    [
      new UnauthenticatedError('invalid-credentials', 'x'),
      401,
      'invalid-credentials',
    ],
    [new HubOfflineError('hub-offline', 'x'), 503, 'hub-offline'],
  ])('maps %o to status %i', (err, status, code) => {
    const res = run(err);
    expect(res.statusCode).toBe(status);
    expect(res.body.type).toBe(`${BASE}/${code}`);
  });

  it('maps Nest HttpException by status code', () => {
    const res = run(new NotFoundException());
    expect(res.statusCode).toBe(404);
    expect(res.body.type).toBe(`${BASE}/not-found`);
    const big = run(new HttpException('too big', 413));
    expect(big.body.type).toBe(`${BASE}/payload-too-large`);
    expect(big.body.detail).toBe('too big');
  });

  it('maps unique violation 23505 to 409', () => {
    const err = new QueryFailedError('INSERT ...', [], {
      code: '23505',
      message: 'duplicate key secret_constraint',
    } as any);
    const res = run(err);
    expect(res.statusCode).toBe(409);
    expect(res.body.type).toBe(`${BASE}/conflict`);
    expect(JSON.stringify(res.body)).not.toContain('secret_constraint');
  });

  it('never exposes driver message or stack on 500', () => {
    const res = run(new Error('SELECT secret FROM x'));
    expect(res.statusCode).toBe(500);
    expect(res.body.type).toBe(`${BASE}/internal-error`);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('SELECT');
    expect(json).not.toContain('stack');
  });

  it('lists invalid fields for RequestValidationError', () => {
    const res = run(
      new RequestValidationError([
        { field: 'device.name', messages: ['name must be a string'] },
      ]),
    );
    expect(res.statusCode).toBe(422);
    expect(res.body.type).toBe(`${BASE}/validation-failed`);
    expect(res.body.errors).toEqual([
      { field: 'device.name', messages: ['name must be a string'] },
    ]);
  });

  it('falls back to a generated request id when request.id is absent', () => {
    const res = run(new NotFoundError('x', 'y'), undefined);
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  describe('hardening', () => {
    it('treats an unmapped DomainError like an unknown error', () => {
      const spy = vi.mocked(Sentry.captureException);
      spy.mockClear();
      class Odd extends DomainError {}
      const res = run(new Odd('odd', 'secret internals'));
      expect(res.statusCode).toBe(500);
      expect(res.body.detail).toBe('An unexpected error occurred');
      expect(JSON.stringify(res.body)).not.toContain('secret internals');
      expect(spy).toHaveBeenCalledOnce();
    });

    it('keeps the status of an HttpException >= 500 with a generic detail', () => {
      const spy = vi.mocked(Sentry.captureException);
      spy.mockClear();
      const res = run(new HttpException('db host 10.0.0.1 down', 503));
      expect(res.statusCode).toBe(503);
      expect(res.body.type).toBe(`${BASE}/service-unavailable`);
      expect(res.body.detail).toBe('An unexpected error occurred');
      expect(spy).toHaveBeenCalledOnce();
    });

    it('answers load shedding with 503 without reporting it to Sentry', () => {
      const spy = vi.mocked(Sentry.captureException);
      spy.mockClear();
      const res = run(new LoadSheddingException());
      expect(res.statusCode).toBe(503);
      expect(res.body.type).toBe(`${BASE}/service-unavailable`);
      expect(res.body.detail).toBe('An unexpected error occurred');
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
