import { ipTracker } from '../../../shared/infra/http/ip-tracker.js';

/**
 * Per-e-mail rate-limit tracker of `POST /hub/user-sessions`: the e-mail of the body, normalized like the identity
 * does (trim -> NFC -> lowercase; the module keeps its own copy, it never imports another module's infra), so
 * spreading attempts over many hubs does not help. Runs before any lookup. IP fallback without a string e-mail (that
 * request is a 422 anyway).
 */
export function hubLoginEmailTracker(req: Record<string, any>): string {
  const email: unknown = req.body?.email;
  return typeof email === 'string'
    ? `email:${email.trim().normalize('NFC').toLowerCase()}`
    : `ip:${ipTracker(req.ip)}`;
}
