import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UserDirectory } from '../../identity/application/user-directory.js';
import { InvitationHooks } from '../../shared/application/invitation-hooks.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { InvitationRepository } from '../domain/invitation.repository.js';
import type { OrgRoleKey } from '../domain/membership.js';
import { MembershipRepository } from '../domain/membership.repository.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import { RoleAssignmentRepository } from '../domain/role-assignment.repository.js';
import { SeatPolicy } from '../domain/seat-policy.js';
import { AuditLog } from './audit-log.js';
import { invitationCreatorCanInvite } from './creator-invitations.js';
import { invitationInvalid } from './invitation-errors.js';
import { OrganizationAccess } from './organization-access.js';
import { InvitationTokenCodec } from './ports/invitation-token-codec.js';

export type AcceptInvitationResult = {
  organizationId: string;
  /** The member's organization role after accepting. */
  roleKey: OrgRoleKey;
  /** True when the user was already an active member: the invitation was consumed, nothing else changed. */
  alreadyMember: boolean;
};

// Aceite de convite (rota logada e gancho de cadastro). Regras, todas na mesma transação:
// - convite pendente, dentro da validade e, se tiver e-mail, igual ao da conta (normalizado);
// - quem criou o convite continua membro ativo com `org.members.manage` (senão o convite morreu com a permissão);
// - assento conferido antes de consumir (membro ativo; convite pendente não conta);
// - `markAccepted` atômico: num aceite concorrente só um vence, o outro recebe `invitation-invalid`;
// - entra como membro (limpa a lápide se já foi membro) com o papel do convite; audita `member.joined`.
// Quem JÁ é membro ativo: o convite é consumido, sem vínculo duplicado e sem trocar o papel atual (um admin
// que aceita um convite de membro não é rebaixado); sem auditoria, porque ninguém entrou.
// Qualquer convite que não vale dá o mesmo `invitation-invalid`. O token nunca é logado nem auditado.
@Injectable()
export class AcceptInvitationUseCase {
  constructor(
    private readonly codec: InvitationTokenCodec,
    private readonly invitations: InvitationRepository,
    private readonly orgs: OrganizationRepository,
    private readonly memberships: MembershipRepository,
    private readonly roles: RoleAssignmentRepository,
    private readonly directory: UserDirectory,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly access: OrganizationAccess,
    private readonly hooks: InvitationHooks,
  ) {}

  async execute(actor: Actor, token: string): Promise<AcceptInvitationResult> {
    const tokenHash = this.codec.hash(token);
    if (tokenHash === null) throw invitationInvalid();
    const [user] = await this.directory.findPublicByIds([actor.userId]);
    return this.accept(
      { userId: actor.userId, email: user?.email ?? null },
      tokenHash,
      new Date(),
    );
  }

  /** For the registration hook: the account e-mail is already known (and the user is in the same transaction). */
  acceptAs(
    user: { userId: string; email: string },
    token: string,
    now: Date,
  ): Promise<AcceptInvitationResult> {
    const tokenHash = this.codec.hash(token);
    if (tokenHash === null) return Promise.reject(invitationInvalid());
    return this.accept(user, tokenHash, now);
  }

  private accept(
    user: { userId: string; email: string | null },
    tokenHash: string,
    now: Date,
  ): Promise<AcceptInvitationResult> {
    return this.uow.run(async () => {
      const invitation = await this.invitations.findByTokenHash(tokenHash);
      if (!invitation?.canBeAcceptedBy(user.email, now)) {
        throw invitationInvalid();
      }
      // Quem convidou ainda precisa poder convidar (admin removido/rebaixado não volta pelo próprio link).
      if (!(await invitationCreatorCanInvite(this.access, invitation))) {
        throw invitationInvalid();
      }
      const orgId = invitation.organizationId;
      const existing = await this.memberships.find(orgId, user.userId);
      if (existing) {
        await this.consume(orgId, invitation.id, user.userId, now);
        // Já era membro: o convite foi consumido, mas o `spaces` ainda decide o que fazer com as intenções dele.
        await this.notifyAccepted(orgId, invitation.id, user.userId, now);
        return {
          organizationId: orgId,
          roleKey: existing.roleKey,
          alreadyMember: true,
        };
      }
      const org = await this.orgs.findById(orgId);
      if (!org) throw invitationInvalid();
      SeatPolicy.assertSeatAvailable(
        await this.memberships.countActive(orgId),
        org.plan,
      );
      await this.consume(orgId, invitation.id, user.userId, now);
      await this.memberships.add(orgId, user.userId, now);
      await this.roles.assignOrgRole(
        orgId,
        user.userId,
        invitation.roleKey,
        invitation.createdBy,
      );
      await this.audit.record({
        organizationId: orgId,
        userId: user.userId,
        action: 'member.joined',
        metadata: { invitationId: invitation.id, roleKey: invitation.roleKey },
      });
      await this.notifyAccepted(orgId, invitation.id, user.userId, now);
      return {
        organizationId: orgId,
        roleKey: invitation.roleKey,
        alreadyMember: false,
      };
    });
  }

  // Dentro da transação do aceite (rota logada e gancho de cadastro passam por aqui): erro desfaz o aceite.
  private notifyAccepted(
    organizationId: string,
    invitationId: string,
    userId: string,
    now: Date,
  ): Promise<void> {
    return this.hooks.onAccepted({
      organizationId,
      invitationId,
      userId,
      now,
    });
  }

  private async consume(
    orgId: string,
    invitationId: string,
    userId: string,
    now: Date,
  ): Promise<void> {
    if (
      !(await this.invitations.markAccepted(orgId, invitationId, userId, now))
    ) {
      throw invitationInvalid();
    }
  }
}
