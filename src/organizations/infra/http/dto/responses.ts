import type { InvitationView } from '../../../application/dto/invitation-view.js';
import type { MemberView } from '../../../application/dto/member-view.js';
import type { OrganizationView } from '../../../application/dto/organization-view.js';

export function organizationResponse(v: OrganizationView) {
  return {
    id: v.id,
    name: v.name,
    isPersonal: v.isPersonal,
    hubLinkPolicy: v.hubLinkPolicy,
    plan: v.plan,
    recoveryPublicKey: v.recoveryPublicKey,
    roleKey: v.roleKey,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

export function memberResponse(v: MemberView) {
  return {
    userId: v.userId,
    name: v.name,
    email: v.email,
    publicKey: v.publicKey,
    roleKey: v.roleKey,
    joinedAt: v.joinedAt ? v.joinedAt.toISOString() : null,
  };
}

export function invitationResponse(v: InvitationView) {
  return {
    id: v.id,
    organizationId: v.organizationId,
    email: v.email,
    roleKey: v.roleKey,
    status: v.status,
    expiresAt: v.expiresAt.toISOString(),
    createdBy: v.createdBy,
    createdAt: v.createdAt ? v.createdAt.toISOString() : null,
  };
}

export { pageResponse } from '../../../../shared/infra/http/cursor-pagination.query.js';
