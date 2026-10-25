import type { InvitationRepository } from '../domain/invitation.repository.js';
import type { Invitation } from '../domain/invitation.js';
import type { AuditLog } from './audit-log.js';
import type { OrganizationAccess } from './organization-access.js';

// Um convite vale enquanto quem o criou ainda pode convidar. Sem isso, um admin removido ou rebaixado voltaria
// pelo próprio link pendente (o aceite reativa o vínculo). Duas travas:
// - ao perder a permissão (removido, saiu, rebaixado), os convites pendentes dele são revogados na mesma
//   transação (`revokeInvitationsOfCreator`);
// - prévia e aceite reconferem o criador (`invitationCreatorCanInvite`) — cobre o que escapar da primeira.

/** The permission an invitation's creator must still hold for it to be valid. */
const INVITE_PERMISSION = 'org.members.manage';

export function invitationCreatorCanInvite(
  access: OrganizationAccess,
  invitation: Invitation,
): Promise<boolean> {
  return access.hasPermission(
    invitation.organizationId,
    invitation.createdBy,
    INVITE_PERMISSION,
  );
}

/**
 * MUST run inside the `UnitOfWork.run` of the action that took the permission away. Audits one
 * `invitation.revoked` per invitation (no token), attributed to `actorId`.
 */
export async function revokeInvitationsOfCreator(
  deps: { invitations: InvitationRepository; audit: AuditLog },
  orgId: string,
  creatorId: string,
  actorId: string,
  now: Date,
): Promise<void> {
  const revoked = await deps.invitations.revokePendingCreatedBy(
    orgId,
    creatorId,
    now,
  );
  for (const invitationId of revoked) {
    await deps.audit.record({
      organizationId: orgId,
      userId: actorId,
      action: 'invitation.revoked',
      metadata: { invitationId, reason: 'creator_lost_permission' },
    });
  }
}
