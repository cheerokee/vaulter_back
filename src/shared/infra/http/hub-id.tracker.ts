import { ipTracker } from './ip-tracker.js';

/**
 * Rate-limit tracker for hub routes (`@HubAuth()`): the hub from `request.hub`, set by the HubTokenGuard, which
 * runs BEFORE the throttler (HubsModule comes before ThrottlingModule in AppModule; pinned by e2e). Changing IP
 * does not reset the counter, and two hubs behind one IP do not share it. IP fallback if there is no hub.
 */
export function hubIdTracker(req: Record<string, any>): string {
  const hubId: unknown = req.hub?.hubId;
  return typeof hubId === 'string' ? `hub:${hubId}` : `ip:${ipTracker(req.ip)}`;
}
