import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import {
  InvitationHooks,
  type InvitationSpaceIntent,
} from '../../shared/application/invitation-hooks.js';
import { DomainValidationError } from '../../shared/domain/errors.js';
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
  /** Spaces the invitee should get access to once they accept; handled by the `spaces` module via hooks. */
  spaces?: InvitationSpaceIntent[];
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
    private readonly hooks: InvitationHooks,
  ) {}

  execute(
    actor: Actor,
    orgId: string,
    input: CreateInvitationInput,
  ): Promise<{ invitation: InvitationView; token: string }> {
    const spaces = input.spaces ?? [];
    return this.uow.run(async () => {
      if (new Set(spaces.map((s) => s.spaceId)).size !== spaces.length) {
        throw new DomainValidationError(
          'duplicate-space',
          'A space can appear only once in an invitation.',
        );
      }
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
      // Só com espaços; o `spaces` valida e grava as intenções (ou lança, e o convite não existe).
      if (spaces.length > 0) {
        await this.hooks.validateAndRecord({
          organizationId: orgId,
          invitationId: invitation.id,
          actorId: actor.userId,
          spaces,
        });
      }
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
