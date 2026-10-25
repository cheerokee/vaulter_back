import type { Invitation, InvitationStatus } from '../../domain/invitation.js';
import type { OrgRoleKey } from '../../domain/membership.js';

/** Admin view of an invitation: never the token nor its hash. */
export type InvitationView = {
  id: string;
  organizationId: string;
  email: string | null;
  roleKey: OrgRoleKey;
  status: InvitationStatus;
  expiresAt: Date;
  createdBy: string;
  createdAt: Date | null;
};

export function toInvitationView(
  invitation: Invitation,
  now: Date,
): InvitationView {
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    email: invitation.email,
    roleKey: invitation.roleKey,
    status: invitation.effectiveStatus(now),
    expiresAt: invitation.expiresAt,
    createdBy: invitation.createdBy,
    createdAt: invitation.createdAt ?? null,
  };
}

/** Public preview (the link may leak): no e-mail at all. */
export type InvitationPreview = {
  organizationName: string;
  invitedByName: string | null;
  expiresAt: Date;
};
