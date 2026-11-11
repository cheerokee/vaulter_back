import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HubsModule } from '../hubs/hubs.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { CreateSupportRequestUseCase } from './application/create-support-request.use-case.js';
import { DecideSupportRequestUseCase } from './application/decide-support-request.use-case.js';
import { GetSupportRequestUseCase } from './application/get-support-request.use-case.js';
import { ListSupportRequestsUseCase } from './application/list-support-requests.use-case.js';
import { SupportRequestExecutor } from './application/support-request-executor.js';
import { GetPlatformMeUseCase } from './application/get-platform-me.use-case.js';
import { GrantPlatformRoleUseCase } from './application/grant-platform-role.use-case.js';
import { ListStaffUseCase } from './application/list-staff.use-case.js';
import { ListPlatformAuditUseCase } from './application/list-platform-audit.use-case.js';
import {
  LookupHubUseCase,
  LookupOrganizationUseCase,
  LookupUserUseCase,
} from './application/lookup.use-cases.js';
import { PlatformAccess } from './application/platform-access.js';
import { PlatformAudit } from './application/platform-audit.js';
import { SetOrganizationAiBudgetUseCase } from './application/set-organization-ai-budget.use-case.js';
import { SetOrganizationStorageQuotaUseCase } from './application/set-organization-storage-quota.use-case.js';
import { RevokePlatformRoleUseCase } from './application/revoke-platform-role.use-case.js';
import { PlatformAuditLogRepository } from './domain/platform-audit-log.repository.js';
import { PlatformRoleRepository } from './domain/platform-role.repository.js';
import { SupportRequestRepository } from './domain/support-request.repository.js';
import { PlatformAuditLogTypeormEntity } from './infra/db/platform-audit-log.entity.js';
import { PlatformAuditLogTypeormRepository } from './infra/db/platform-audit-log.typeorm-repository.js';
import { PlatformPermissionTypeormEntity } from './infra/db/platform-permission.entity.js';
import { PlatformRolePermissionTypeormEntity } from './infra/db/platform-role-permission.entity.js';
import { PlatformRoleTypeormEntity } from './infra/db/platform-role.entity.js';
import { PlatformRoleTypeormRepository } from './infra/db/platform-role.typeorm-repository.js';
import { PlatformSupportRequestTypeormEntity } from './infra/db/platform-support-request.entity.js';
import { SupportRequestTypeormRepository } from './infra/db/support-request.typeorm-repository.js';
import { UserPlatformRoleTypeormEntity } from './infra/db/user-platform-role.entity.js';
import { PlatformAuditController } from './infra/http/platform-audit.controller.js';
import { PlatformLookupController } from './infra/http/platform-lookup.controller.js';
import { PlatformMeController } from './infra/http/platform-me.controller.js';
import { PlatformOrganizationsController } from './infra/http/platform-organizations.controller.js';
import { PlatformPermissionGuard } from './infra/http/platform-permission.guard.js';
import { PlatformStaffController } from './infra/http/platform-staff.controller.js';
import { SupportRequestsController } from './infra/http/support-requests.controller.js';

// Papéis da equipe da plataforma (spec docs/superpowers/specs/2026-11-07-platform-roles-design.md). Depende de
// identity, organizations e hubs só pelo que eles exportam; nenhum deles importa `platform`.
@Module({
  controllers: [
    PlatformMeController,
    PlatformStaffController,
    SupportRequestsController,
    PlatformLookupController,
    PlatformAuditController,
    PlatformOrganizationsController,
  ],
  imports: [
    // UserDirectory (nome/e-mail da equipe) e CurrentAuthProofVerifier (reautenticação).
    IdentityModule,
    // OrganizationAdministration (nomear admin) e HubAdministration (desregistro forçado), sem autorização própria.
    OrganizationsModule,
    HubsModule,
    TypeOrmModule.forFeature([
      PlatformRoleTypeormEntity,
      PlatformPermissionTypeormEntity,
      PlatformRolePermissionTypeormEntity,
      UserPlatformRoleTypeormEntity,
      PlatformSupportRequestTypeormEntity,
      PlatformAuditLogTypeormEntity,
    ]),
  ],
  providers: [
    {
      provide: PlatformRoleRepository,
      useClass: PlatformRoleTypeormRepository,
    },
    {
      provide: PlatformAuditLogRepository,
      useClass: PlatformAuditLogTypeormRepository,
    },
    PlatformAccess,
    PlatformAudit,
    // Global and registered before the ThrottlingModule (see AppModule): a hidden /platform route answers its 404
    // before the throttler counts it or sets X-RateLimit-* (fixed by test/platform/staff.e2e-spec.ts).
    { provide: APP_GUARD, useClass: PlatformPermissionGuard },
    GetPlatformMeUseCase,
    ListStaffUseCase,
    GrantPlatformRoleUseCase,
    RevokePlatformRoleUseCase,
    {
      provide: SupportRequestRepository,
      useClass: SupportRequestTypeormRepository,
    },
    SupportRequestExecutor,
    CreateSupportRequestUseCase,
    DecideSupportRequestUseCase,
    ListSupportRequestsUseCase,
    GetSupportRequestUseCase,
    LookupUserUseCase,
    LookupHubUseCase,
    LookupOrganizationUseCase,
    ListPlatformAuditUseCase,
    SetOrganizationStorageQuotaUseCase,
    SetOrganizationAiBudgetUseCase,
  ],
  exports: [PlatformAccess, PlatformAudit],
})
export class PlatformModule {}
