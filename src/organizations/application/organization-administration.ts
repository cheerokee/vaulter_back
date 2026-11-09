import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { UserDirectory } from '../../identity/application/user-directory.js';
import {
  auditActorFields,
  type AuditActor,
} from '../../shared/application/audit-actor.js';
import {
  DomainValidationError,
  NotFoundError,
} from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { MembershipRepository } from '../domain/membership.repository.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import { RoleAssignmentRepository } from '../domain/role-assignment.repository.js';
import { SeatPolicy } from '../domain/seat-policy.js';
import { AuditLog } from './audit-log.js';
import { lockOrganization } from './load-organization.js';

/** What the platform team sees of an organization: no key, nothing encrypted. */
export type OrganizationAdministrationSummary = {
  organizationId: string;
  name: string;
  personal: boolean;
  /** Active org_admin user ids, in id order. */
  adminUserIds: string[];
  memberCount: number;
};

function organizationNotFound(): NotFoundError {
  return new NotFoundError(
    'organization-not-found',
    'The organization was not found.',
  );
}

// Operações administrativas da organização, exportadas (plano platform-roles): NÃO autorizam ninguém. Quem chama já
// decidiu que pode (a plataforma, pela permissão e pelo pedido de suporte dela). O `organizations` não conhece o
// módulo `platform`: a origem chega como `AuditActor` e vai para toda gravação de auditoria (`auditActorFields`).
@Injectable()
export class OrganizationAdministration {
  constructor(
    private readonly orgs: OrganizationRepository,
    private readonly memberships: MembershipRepository,
    private readonly roles: RoleAssignmentRepository,
    private readonly users: UserDirectory,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  /**
   * Makes `userId` an org_admin of `orgId`, valid even when the organization already has admins (the lost account
   * stays; the new admin removes it through the normal flow). A registered non-member joins first (seat policy,
   * membership, `member.joined`); then the role and `member.role_changed`. Already admin: nothing is written.
   * Personal organization: 422 `personal-organization-protected`; unknown organization or user: 404.
   * Locks like the other membership changes: org_admin assignments (`lockOrgAdmins`) before reading the target,
   * then the organization row. When it writes, it (re)starts the organization's protection window
   * (`recordPlatformAppointment`: no kit change and no member removal for anyone for 7 days).
   */
  appointAdmin(
    orgId: string,
    userId: string,
    actor: AuditActor,
    now: Date,
  ): Promise<{ joined: boolean }> {
    if (!validate(orgId)) return Promise.reject(organizationNotFound());
    const origin = auditActorFields(actor);
    return this.uow.run(() =>
      this.uow.withContext({ organizationId: orgId }, async () => {
        const org = await this.orgs.findById(orgId);
        if (!org) throw organizationNotFound();
        if (org.isPersonal) {
          throw new DomainValidationError(
            'personal-organization-protected',
            'A personal organization cannot get another admin.',
          );
        }
        const [user] = validate(userId)
          ? await this.users.findPublicByIds([userId])
          : [];
        if (!user) {
          throw new NotFoundError('user-not-found', 'The user was not found.');
        }

        await this.roles.lockOrgAdmins(orgId);
        const existing = await this.memberships.find(orgId, userId);
        if (existing?.roleKey === 'org_admin') return { joined: false };
        if (!existing) {
          SeatPolicy.assertSeatAvailable(
            await this.memberships.countActive(orgId),
            org.plan,
          );
          await this.memberships.add(orgId, userId, now);
          await this.audit.record({
            organizationId: orgId,
            userId: origin.userId,
            action: 'member.joined',
            metadata: {
              ...origin.metadata,
              targetUserId: userId,
              roleKey: 'org_admin',
            },
          });
        }
        await this.roles.assignOrgRole(
          orgId,
          userId,
          'org_admin',
          origin.userId,
        );
        await this.audit.record({
          organizationId: orgId,
          userId: origin.userId,
          action: 'member.role_changed',
          metadata: {
            ...origin.metadata,
            targetUserId: userId,
            from: existing?.roleKey ?? null,
            to: 'org_admin',
          },
        });
        // Janela de proteção (decisão do Jonas, 09/11/2026): só quando a nomeação grava; uma nova a reinicia. A linha
        // é relida travada (org_admin -> organização), para não gravar campos velhos sobre um kit trocado no meio.
        const locked = await lockOrganization(this.orgs, orgId);
        locked.recordPlatformAppointment(userId, now);
        await this.orgs.save(locked);
        return { joined: !existing };
      }),
    );
  }

  /** Read-only view of an organization; null when unknown or malformed. */
  async summary(
    orgId: string,
  ): Promise<OrganizationAdministrationSummary | null> {
    if (!validate(orgId)) return null;
    return this.uow.withContext({ organizationId: orgId }, async () => {
      const org = await this.orgs.findById(orgId);
      if (!org) return null;
      return {
        organizationId: org.id,
        name: org.name,
        personal: org.isPersonal,
        adminUserIds: await this.roles.orgAdminIds(orgId),
        memberCount: await this.memberships.countActive(orgId),
      };
    });
  }
}
