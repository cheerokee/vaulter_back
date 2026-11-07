import {
  REQUESTER_LOST_PERMISSION,
  type SupportRequest,
} from '../domain/support-request.js';
import type { SupportRequestRepository } from '../domain/support-request.repository.js';
import type {
  PlatformAudit,
  PlatformAuditAction,
  PlatformAuditEntry,
} from './platform-audit.js';

/** A platform trail entry about `request`: its id, its targets and its type (never the reason or evidence). */
export function supportRequestAuditEntry(
  request: SupportRequest,
  action: PlatformAuditAction,
  userId: string | null,
  extra: Record<string, unknown> = {},
): PlatformAuditEntry {
  return {
    userId,
    action,
    result: action === 'platform.request.failed' ? 'error' : 'success',
    supportRequestId: request.id,
    ...(request.targetHubId ? { targetHubId: request.targetHubId } : {}),
    ...(request.targetOrganizationId
      ? { targetOrganizationId: request.targetOrganizationId }
      : {}),
    ...(request.targetUserId ? { targetUserId: request.targetUserId } : {}),
    metadata: { type: request.type, ...extra },
  };
}

/**
 * Lazy expiry (spec §4.3: 7 days without a decision), on reads and decisions: when `request` is due, saves it as
 * `expired` and audits `platform.request.expired` with no user (nobody acted: the clock did). Inside a unit of work,
 * with the row locked. True when it expired now.
 */
export async function expireIfDue(
  request: SupportRequest,
  now: Date,
  repo: SupportRequestRepository,
  audit: PlatformAudit,
): Promise<boolean> {
  if (!request.expireIfDue(now)) return false;
  await persistExpiry(request, repo, audit);
  return true;
}

/** Saves a request the domain already turned `expired` and audits it. */
export async function persistExpiry(
  request: SupportRequest,
  repo: SupportRequestRepository,
  audit: PlatformAudit,
): Promise<void> {
  await repo.save(request);
  await audit.record(
    supportRequestAuditEntry(request, 'platform.request.expired', null),
  );
}

/**
 * The requester lost `platform.support.request`: rejects `request` (pending, no decision, row locked) with the note
 * `requester_lost_permission`, saves it and audits `platform.request.rejected` with no user (nobody decided) and
 * `metadata.reason`. A due one is expired instead (`platform.request.expired`). Inside a unit of work.
 */
export async function rejectForLostPermission(
  request: SupportRequest,
  now: Date,
  repo: SupportRequestRepository,
  audit: PlatformAudit,
): Promise<void> {
  if (request.rejectForLostPermission(now) === 'expired') {
    await persistExpiry(request, repo, audit);
    return;
  }
  await repo.save(request);
  await audit.record(
    supportRequestAuditEntry(request, 'platform.request.rejected', null, {
      reason: REQUESTER_LOST_PERMISSION,
    }),
  );
}
