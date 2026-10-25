import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import type { Actor } from '../../identity/application/dto/actor.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { InvitationRepository } from '../domain/invitation.repository.js';
import { AuditLog } from './audit-log.js';
import { OrganizationAccess } from './organization-access.js';

@Injectable()
export class RevokeInvitationUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly invitations: InvitationRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(actor: Actor, orgId: string, invitationId: string): Promise<void> {
    return this.uow.run(async () => {
      await this.access.requirePermission(
        orgId,
        actor.userId,
        'org.members.manage',
      );
      // Só um convite pendente desta organização é revogado; o resto (inexistente, já aceito, revogado) é 404.
      const revoked =
        validate(invitationId) &&
        (await this.invitations.revoke(orgId, invitationId));
      if (!revoked) {
        throw new NotFoundError(
          'invitation-not-found',
          'No pending invitation with this id.',
        );
      }
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'invitation.revoked',
        metadata: { invitationId },
      });
    });
  }
}
