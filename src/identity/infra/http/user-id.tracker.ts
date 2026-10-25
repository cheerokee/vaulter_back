import { ipTracker } from '../../../shared/infra/http/ip-tracker.js';
/**
 * Rate-limit tracker for authenticated routes: the user from `request.auth` (set by the access token
 * guard, which runs first), so changing IP does not reset the counter. IP fallback if there is no auth.
 */
export function userIdTracker(req: Record<string, any>): string {
  const userId: unknown = req.auth?.userId;
  return typeof userId === 'string'
    ? `user:${userId}`
    : `ip:${ipTracker(req.ip)}`;
}
