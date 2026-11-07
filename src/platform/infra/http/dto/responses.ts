import type { PlatformAuditRecord } from '../../../domain/platform-audit-log.repository.js';
import type { PlatformMeView } from '../../../application/get-platform-me.use-case.js';
import type { StaffMemberView } from '../../../application/list-staff.use-case.js';
import type { SupportRequest } from '../../../domain/support-request.js';

export function platformMeResponse(v: PlatformMeView) {
  return { roles: v.roles, permissions: v.permissions };
}

export function staffMemberResponse(v: StaffMemberView) {
  return { userId: v.userId, name: v.name, email: v.email, roles: v.roles };
}

export function supportRequestResponse(r: SupportRequest) {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    hubId: r.targetHubId,
    organizationId: r.targetOrganizationId,
    userId: r.targetUserId,
    reason: r.reason,
    evidence: r.evidence,
    requestedByUserId: r.requestedBy,
    decidedByUserId: r.decidedBy,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    executedAt: r.executedAt?.toISOString() ?? null,
    failureType: r.failureType,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt?.toISOString() ?? null,
  };
}

export function platformAuditResponse(r: PlatformAuditRecord) {
  return {
    id: r.id,
    action: r.action,
    result: r.result,
    userId: r.userId,
    supportRequestId: r.supportRequestId ?? null,
    targetUserId: r.targetUserId ?? null,
    targetHubId: r.targetHubId ?? null,
    targetOrganizationId: r.targetOrganizationId ?? null,
    metadata: r.metadata ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
