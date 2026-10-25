import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module.js';
import { AcceptInvitationUseCase } from './application/accept-invitation.use-case.js';
import { AuditLog } from './application/audit-log.js';
import { ChangeMemberRoleUseCase } from './application/change-member-role.use-case.js';
import { CreateInvitationUseCase } from './application/create-invitation.use-case.js';
import { CreateOrganizationUseCase } from './application/create-organization.use-case.js';
import { GetOrganizationUseCase } from './application/get-organization.use-case.js';
import { LeaveOrganizationUseCase } from './application/leave-organization.use-case.js';
import { ListInvitationsUseCase } from './application/list-invitations.use-case.js';
import { ListMembersUseCase } from './application/list-members.use-case.js';
import { ListMyOrganizationsUseCase } from './application/list-my-organizations.use-case.js';
import { OrganizationDirectory } from './application/organization-directory.js';
import { OrganizationAccess } from './application/organization-access.js';
import { PersonalOrganizationRegistrationHook } from './application/personal-organization.registration-hook.js';
import { InvitationTokenCodec } from './application/ports/invitation-token-codec.js';
import { PreviewInvitationUseCase } from './application/preview-invitation.use-case.js';
import { RemoveMemberUseCase } from './application/remove-member.use-case.js';
import { RevokeInvitationUseCase } from './application/revoke-invitation.use-case.js';
import { SetRecoveryKeyUseCase } from './application/set-recovery-key.use-case.js';
import { UpdateOrganizationUseCase } from './application/update-organization.use-case.js';
import { SodiumInvitationTokenCodec } from './infra/crypto/sodium-invitation-token-codec.js';
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
import { InvitationsController } from './infra/http/invitations.controller.js';
import { MembersController } from './infra/http/members.controller.js';
import { OrganizationsController } from './infra/http/organizations.controller.js';
import { UserOrganizationTypeormEntity } from './infra/db/user-organization.entity.js';

@Module({
  controllers: [
    OrganizationsController,
    MembersController,
    InvitationsController,
  ],
  imports: [
    // Uma direção só: organizations usa o que o identity exporta (UserDirectory, CurrentAuthProofVerifier).
    IdentityModule,
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
    { provide: InvitationTokenCodec, useClass: SodiumInvitationTokenCodec },
    OrganizationAccess,
    OrganizationDirectory,
    AuditLog,
    CreateOrganizationUseCase,
    ListMyOrganizationsUseCase,
    GetOrganizationUseCase,
    UpdateOrganizationUseCase,
    SetRecoveryKeyUseCase,
    ListMembersUseCase,
    ChangeMemberRoleUseCase,
    RemoveMemberUseCase,
    LeaveOrganizationUseCase,
    CreateInvitationUseCase,
    ListInvitationsUseCase,
    RevokeInvitationUseCase,
    PreviewInvitationUseCase,
    AcceptInvitationUseCase,
    PersonalOrganizationRegistrationHook,
  ],
  exports: [
    OrganizationAccess,
    OrganizationDirectory,
    AuditLog,
    AcceptInvitationUseCase,
  ],
})
export class OrganizationsModule {}
