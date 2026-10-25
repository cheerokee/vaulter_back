import type { CursorPage } from '../../../../shared/domain/pagination.js';
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

export function pageResponse<T, R>(
  page: CursorPage<T>,
  map: (item: T) => R,
): { items: R[]; nextCursor: string | null } {
  return { items: page.items.map(map), nextCursor: page.nextCursor };
}
