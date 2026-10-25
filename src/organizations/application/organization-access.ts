import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import {
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import type { Membership } from '../domain/membership.js';
import { MembershipRepository } from '../domain/membership.repository.js';
import type { PermissionKey } from '../domain/rbac-catalog.js';
import { RoleAssignmentRepository } from '../domain/role-assignment.repository.js';

// Checagem de acesso exportada para os outros módulos: "este usuário é membro / tem a permissão X nesta
// organização?". Não membro (ou organização inexistente) recebe 404, para não revelar que ela existe.
@Injectable()
export class OrganizationAccess {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly roles: RoleAssignmentRepository,
  ) {}

  async requireMember(orgId: string, userId: string): Promise<Membership> {
    // Um id malformado nunca é de uma organização (e não chega ao banco como uuid inválido).
    const membership = validate(orgId)
      ? await this.memberships.find(orgId, userId)
      : null;
    if (!membership) {
      throw new NotFoundError(
        'organization-not-found',
        'The organization was not found.',
      );
    }
    return membership;
  }

  async requirePermission(
    orgId: string,
    userId: string,
    permission: PermissionKey,
  ): Promise<Membership> {
    const membership = await this.requireMember(orgId, userId);
    const permissions = await this.roles.permissionsOf(orgId, userId);
    if (!permissions.includes(permission)) {
      throw new PermissionDeniedError(
        'permission-denied',
        'You do not have permission to perform this action.',
      );
    }
    return membership;
  }
}
