import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogRepository } from './domain/audit-log.repository.js';
import { InvitationRepository } from './domain/invitation.repository.js';
import { MembershipRepository } from './domain/membership.repository.js';
import { OrganizationRepository } from './domain/organization.repository.js';
import { RoleAssignmentRepository } from './domain/role-assignment.repository.js';
import { AuditLogTypeormEntity } from './infra/db/audit-log.entity.js';
import { AuditLogTypeormRepository } from './infra/db/audit-log.typeorm-repository.js';
import { InvitationTypeormRepository } from './infra/db/invitation.typeorm-repository.js';
import { MembershipTypeormRepository } from './infra/db/membership.typeorm-repository.js';
import { OrganizationInvitationTypeormEntity } from './infra/db/organization-invitation.entity.js';
import { OrganizationTypeormEntity } from './infra/db/organization.entity.js';
import { OrganizationTypeormRepository } from './infra/db/organization.typeorm-repository.js';
import { PermissionDependencyTypeormEntity } from './infra/db/permission-dependency.entity.js';
import { PermissionTypeormEntity } from './infra/db/permission.entity.js';
import { RoleAssignmentTypeormEntity } from './infra/db/role-assignment.entity.js';
import { RoleAssignmentTypeormRepository } from './infra/db/role-assignment.typeorm-repository.js';
import { RolePermissionTypeormEntity } from './infra/db/role-permission.entity.js';
import { RoleTypeormEntity } from './infra/db/role.entity.js';
import { UserOrganizationTypeormEntity } from './infra/db/user-organization.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PermissionTypeormEntity,
      PermissionDependencyTypeormEntity,
      RoleTypeormEntity,
      RolePermissionTypeormEntity,
      OrganizationTypeormEntity,
      UserOrganizationTypeormEntity,
      RoleAssignmentTypeormEntity,
      OrganizationInvitationTypeormEntity,
      AuditLogTypeormEntity,
    ]),
  ],
  providers: [
    {
      provide: OrganizationRepository,
      useClass: OrganizationTypeormRepository,
    },
    { provide: MembershipRepository, useClass: MembershipTypeormRepository },
    {
      provide: RoleAssignmentRepository,
      useClass: RoleAssignmentTypeormRepository,
    },
    { provide: InvitationRepository, useClass: InvitationTypeormRepository },
    { provide: AuditLogRepository, useClass: AuditLogTypeormRepository },
  ],
})
export class OrganizationsModule {}
