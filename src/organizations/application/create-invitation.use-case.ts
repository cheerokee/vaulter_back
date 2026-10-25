import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { Invitation } from '../domain/invitation.js';
import { InvitationRepository } from '../domain/invitation.repository.js';
import type { OrgRoleKey } from '../domain/membership.js';
import { MembershipRepository } from '../domain/membership.repository.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import { SeatPolicy } from '../domain/seat-policy.js';
import { AuditLog } from './audit-log.js';
import {
  toInvitationView,
  type InvitationView,
} from './dto/invitation-view.js';
import { loadOrganization } from './load-organization.js';
import { OrganizationAccess } from './organization-access.js';
import { InvitationTokenCodec } from './ports/invitation-token-codec.js';

export type CreateInvitationInput = {
  roleKey: OrgRoleKey;
  email?: string | null;
};

// O `token` sai daqui UMA vez (o app monta o link). Ele nunca é logado nem auditado; o banco guarda só o hash.
@Injectable()
export class CreateInvitationUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly orgs: OrganizationRepository,
    private readonly memberships: MembershipRepository,
    private readonly invitations: InvitationRepository,
    private readonly codec: InvitationTokenCodec,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    orgId: string,
    input: CreateInvitationInput,
  ): Promise<{ invitation: InvitationView; token: string }> {
    return this.uow.run(async () => {
      await this.access.requirePermission(
        orgId,
        actor.userId,
        'org.members.manage',
      );
      const org = await loadOrganization(this.orgs, orgId);
      SeatPolicy.assertSeatAvailable(
        await this.memberships.countActive(orgId),
        org.plan,
      );
      const now = new Date();
      const { token, tokenHash } = this.codec.generate();
      const invitation = Invitation.issue({
        organizationId: orgId,
        roleKey: input.roleKey,
        email: input.email ?? null,
        createdBy: actor.userId,
        tokenHash,
        now,
      });
      await this.invitations.create(invitation);
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'invitation.created',
        metadata: { invitationId: invitation.id, roleKey: invitation.roleKey },
      });
      return { invitation: toInvitationView(invitation, now), token };
    });
  }
}
