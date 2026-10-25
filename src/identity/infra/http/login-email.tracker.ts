import { ipTracker } from '../../../shared/infra/http/ip-tracker.js';
import { normalizeEmail } from '../../domain/email.js';

/**
 * Rate-limit tracker for POST /auth/login: the normalized e-mail from the body (the same
 * normalization the login use case applies), so spreading attempts over many IPs does not help.
 * Runs before any lookup, so the outcome is identical for existing and unknown e-mails.
 * Falls back to the IP when the body has no string e-mail (that request is a 422 anyway).
 */
export function loginEmailTracker(req: Record<string, any>): string {
  const email: unknown = req.body?.email;
  return typeof email === 'string'
    ? `email:${normalizeEmail(email)}`
    : `ip:${ipTracker(req.ip)}`;
}
