import type { Breadcrumb, ErrorEvent, NodeOptions } from '@sentry/nestjs';
import { scrubSensitive } from './sensitive-fields.js';

type TransactionEvent = Parameters<
  NonNullable<NodeOptions['beforeSendTransaction']>
>[0];

// Nunca envia corpo de requisição; cabeçalhos, extra, contexts e breadcrumbs passam pela limpeza.
function scrubEvent<T extends ErrorEvent | TransactionEvent>(event: T): T {
  if (event.request) {
    delete event.request.data;
    if (event.request.headers) {
      event.request.headers = scrubSensitive(event.request.headers);
    }
    delete event.request.cookies;
    delete event.request.query_string;
  }
  if (event.extra) event.extra = scrubSensitive(event.extra);
  if (event.contexts) event.contexts = scrubSensitive(event.contexts);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b: Breadcrumb) =>
      b.data ? { ...b, data: scrubSensitive(b.data) } : b,
    );
  }
  const spans = (event as { spans?: { data?: unknown }[] }).spans;
  if (spans) {
    (event as { spans?: unknown[] }).spans = spans.map((sp) =>
      sp.data ? { ...sp, data: scrubSensitive(sp.data) } : sp,
    );
  }
  return event;
}

export function sentryOptions(env: NodeJS.ProcessEnv): NodeOptions {
  const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0);
  return {
    dsn: env.SENTRY_DSN || undefined,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.SENTRY_ENVIRONMENT || 'development',
    // Sentry 11 trocou sendDefaultPii por dataCollection: sem usuário, cookies nem corpos.
    dataCollection: { userInfo: false, cookies: false, httpBodies: [] },
    tracesSampleRate: Number.isFinite(rate) ? rate : 0,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  };
}
