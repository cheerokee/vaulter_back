import { SupportRequest } from '../../domain/support-request.js';
import type { PlatformSupportRequestTypeormEntity } from './platform-support-request.entity.js';

export const SupportRequestMapper = {
  toDomain(row: PlatformSupportRequestTypeormEntity): SupportRequest {
    return SupportRequest.restore(
      {
        type: row.type,
        status: row.status,
        targetHubId: row.targetHubId,
        targetOrganizationId: row.targetOrganizationId,
        targetUserId: row.targetUserId,
        reason: row.reason,
        evidence: row.evidence,
        requestedBy: row.requestedByUserId,
        decidedBy: row.decidedByUserId,
        decidedAt: row.decidedAt,
        decisionNote: row.decisionNote,
        executedAt: row.executedAt,
        failureType: row.failureType,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      },
      row.id,
    );
  },

  toPersistence(
    r: SupportRequest,
  ): Partial<PlatformSupportRequestTypeormEntity> {
    return {
      id: r.id,
      createdAt: r.createdAt,
      type: r.type,
      status: r.status,
      requestedByUserId: r.requestedBy,
      targetHubId: r.targetHubId,
      targetOrganizationId: r.targetOrganizationId,
      targetUserId: r.targetUserId,
      reason: r.reason,
      evidence: r.evidence,
      decidedByUserId: r.decidedBy,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
      executedAt: r.executedAt,
      failureType: r.failureType,
      expiresAt: r.expiresAt,
    };
  },
};
