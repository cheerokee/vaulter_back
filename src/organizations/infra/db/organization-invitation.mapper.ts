import { Invitation } from '../../domain/invitation.js';
import type { OrgRoleKey } from '../../domain/membership.js';
import { OrganizationInvitationTypeormEntity } from './organization-invitation.entity.js';

export const OrganizationInvitationMapper = {
  // A tabela guarda role_id; o domínio fala em roleKey (resolvido pelo repositório com JOIN em roles).
  toDomain(
    row: OrganizationInvitationTypeormEntity,
    roleKey: OrgRoleKey,
  ): Invitation {
    return Invitation.restore(
      {
        organizationId: row.organizationId,
        tokenHash: row.tokenHash,
        email: row.email,
        roleKey,
        status: row.status,
        expiresAt: row.expiresAt,
        createdBy: row.createdByUserId,
        acceptedBy: row.acceptedByUserId,
        acceptedAt: row.acceptedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt ?? undefined,
      },
      row.id,
    );
  },

  toPersistence(
    invitation: Invitation,
    roleId: string,
  ): Partial<OrganizationInvitationTypeormEntity> {
    return {
      id: invitation.id,
      createdAt: invitation.createdAt,
      organizationId: invitation.organizationId,
      tokenHash: invitation.tokenHash,
      email: invitation.email,
      roleId,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      createdByUserId: invitation.createdBy,
      acceptedByUserId: invitation.acceptedBy,
      acceptedAt: invitation.acceptedAt,
    };
  },
};
