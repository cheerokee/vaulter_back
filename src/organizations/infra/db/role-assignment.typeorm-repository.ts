import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { OrgRoleKey } from '../../domain/membership.js';
import type { PermissionKey } from '../../domain/rbac-catalog.js';
import { RoleAssignmentRepository } from '../../domain/role-assignment.repository.js';
import { orgFactoryRoleId } from './factory-roles.js';
import { RoleAssignmentTypeormEntity } from './role-assignment.entity.js';

@Injectable()
export class RoleAssignmentTypeormRepository extends RoleAssignmentRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // Troca o papel da atribuição ativa (uq_role_assignments_org_user garante no máximo uma) ou cria uma.
  async assignOrgRole(
    orgId: string,
    userId: string,
    roleKey: OrgRoleKey,
    grantedBy: string | null,
  ): Promise<void> {
    await runInOrganizationScope(this.dataSource, orgId, async (m) => {
      const roleId = await orgFactoryRoleId(m, roleKey);
      const updated = await m
        .createQueryBuilder()
        .update(RoleAssignmentTypeormEntity)
        .set({ roleId, grantedByUserId: grantedBy })
        .where('organization_id = :orgId AND user_id = :userId', {
          orgId,
          userId,
        })
        .andWhere(`scope_type = 'organization' AND deleted_at IS NULL`)
        .execute();
      if (updated.affected) return;
      await m.getRepository(RoleAssignmentTypeormEntity).insert({
        roleId,
        userId,
        scopeType: 'organization',
        organizationId: orgId,
        grantedByUserId: grantedBy,
      });
    });
  }

  // SELECT ... FOR UPDATE na transação ambiente: o lock vale até o fim do UnitOfWork.run de quem chamou
  // (o savepoint do contexto é liberado, mas o lock passa para a transação de fora).
  async lockOrgAdmins(orgId: string): Promise<string[]> {
    if (!currentManager(this.dataSource).queryRunner?.isTransactionActive) {
      throw new Error(
        'RoleAssignmentRepository.lockOrgAdmins requires an active unit of work (call it inside UnitOfWork.run).',
      );
    }
    const rows: { user_id: string }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT ra.user_id
             FROM role_assignments ra
             JOIN roles r ON r.id = ra.role_id
            WHERE r.key = 'org_admin' AND r.organization_id IS NULL
              AND ra.scope_type = 'organization' AND ra.organization_id = $1
              AND ra.deleted_at IS NULL
            ORDER BY ra.user_id
              FOR UPDATE OF ra`,
          [orgId],
        ),
    );
    return rows.map((r) => r.user_id);
  }

  async orgRoleOf(orgId: string, userId: string): Promise<OrgRoleKey | null> {
    const rows: { key: OrgRoleKey }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT r.key
             FROM role_assignments ra
             JOIN roles r ON r.id = ra.role_id
            WHERE ra.organization_id = $1 AND ra.user_id = $2
              AND ra.scope_type = 'organization' AND ra.deleted_at IS NULL`,
          [orgId, userId],
        ),
    );
    return rows[0]?.key ?? null;
  }

  async permissionsOf(orgId: string, userId: string): Promise<PermissionKey[]> {
    const rows: { key: PermissionKey }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT DISTINCT p.key
             FROM role_assignments ra
             JOIN role_permission rp ON rp.role_id = ra.role_id AND rp.deleted_at IS NULL
             JOIN permissions p ON p.id = rp.permission_id AND p.deleted_at IS NULL
            WHERE ra.organization_id = $1 AND ra.user_id = $2
              AND ra.scope_type = 'organization' AND ra.deleted_at IS NULL
            ORDER BY p.key`,
          [orgId, userId],
        ),
    );
    return rows.map((r) => r.key);
  }
}
