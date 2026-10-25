import type { ErrorEvent } from '@sentry/nestjs';
import { sentryOptions } from './sentry.config.js';

describe('sentryOptions', () => {
  it('is disabled without a DSN', () => {
    const o = sentryOptions({});
    expect(o.enabled).toBe(false);
    expect(o.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpBodies: [],
    });
  });

  it('is enabled with a DSN and reads the sample rate', () => {
    const o = sentryOptions({
      SENTRY_DSN: 'https://k@o.example.invalid/1',
      SENTRY_TRACES_SAMPLE_RATE: '0.25',
    });
    expect(o.enabled).toBe(true);
    expect(o.tracesSampleRate).toBe(0.25);
  });

  it('beforeSend drops the body and scrubs headers, extra, contexts and breadcrumbs', async () => {
    const o = sentryOptions({});
    const event = {
      type: undefined,
      request: {
        data: { authProof: 'x' },
        headers: { authorization: 'Bearer abc', accept: 'json' },
      },
      extra: { refreshToken: 'r', ok: 1 },
      contexts: { c: { kdf_salt: 's' } },
      breadcrumbs: [{ message: 'm', data: { accessToken: 't', n: 1 } }],
    } as unknown as ErrorEvent;
    const out = (await o.beforeSend!(event, {})) as ErrorEvent;
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.headers).toEqual({
      authorization: '[REDACTED]',
      accept: 'json',
    });
    expect(out.extra).toEqual({ refreshToken: '[REDACTED]', ok: 1 });
    expect(out.contexts).toEqual({ c: { kdf_salt: '[REDACTED]' } });
    expect(out.breadcrumbs?.[0]?.data).toEqual({
      accessToken: '[REDACTED]',
      n: 1,
    });
  });

  it('drops query_string and scrubs span data in transactions', async () => {
    const o = sentryOptions({});
    const event = {
      type: 'transaction',
      request: { query_string: 'token=abc', url: '/x' },
      spans: [{ data: { refreshToken: 'r', n: 1 } }, {}],
    } as any;
    const out = (await o.beforeSendTransaction!(event, {})) as any;
    expect(out.request.query_string).toBeUndefined();
    expect(out.spans[0].data).toEqual({ refreshToken: '[REDACTED]', n: 1 });
  });
});
