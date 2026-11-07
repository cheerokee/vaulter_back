import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module.js';
import { GetPlatformMeUseCase } from './application/get-platform-me.use-case.js';
import { GrantPlatformRoleUseCase } from './application/grant-platform-role.use-case.js';
import { ListStaffUseCase } from './application/list-staff.use-case.js';
import { PlatformAccess } from './application/platform-access.js';
import { PlatformAudit } from './application/platform-audit.js';
import { RevokePlatformRoleUseCase } from './application/revoke-platform-role.use-case.js';
import { PlatformAuditLogRepository } from './domain/platform-audit-log.repository.js';
import { PlatformRoleRepository } from './domain/platform-role.repository.js';
import { PlatformAuditLogTypeormEntity } from './infra/db/platform-audit-log.entity.js';
import { PlatformAuditLogTypeormRepository } from './infra/db/platform-audit-log.typeorm-repository.js';
import { PlatformPermissionTypeormEntity } from './infra/db/platform-permission.entity.js';
import { PlatformRolePermissionTypeormEntity } from './infra/db/platform-role-permission.entity.js';
import { PlatformRoleTypeormEntity } from './infra/db/platform-role.entity.js';
import { PlatformRoleTypeormRepository } from './infra/db/platform-role.typeorm-repository.js';
import { PlatformSupportRequestTypeormEntity } from './infra/db/platform-support-request.entity.js';
import { UserPlatformRoleTypeormEntity } from './infra/db/user-platform-role.entity.js';
import { PlatformMeController } from './infra/http/platform-me.controller.js';
import { PlatformPermissionGuard } from './infra/http/platform-permission.guard.js';
import { PlatformStaffController } from './infra/http/platform-staff.controller.js';

// Papéis da equipe da plataforma (spec docs/superpowers/specs/2026-11-07-platform-roles-design.md). Depende de
// identity, organizations e hubs só pelo que eles exportam; nenhum deles importa `platform`.
@Module({
  controllers: [PlatformMeController, PlatformStaffController],
  imports: [
    // UserDirectory (nome/e-mail da equipe) e CurrentAuthProofVerifier (reautenticação).
    IdentityModule,
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
    PlatformPermissionGuard,
    GetPlatformMeUseCase,
    ListStaffUseCase,
    GrantPlatformRoleUseCase,
    RevokePlatformRoleUseCase,
  ],
  exports: [PlatformAccess, PlatformAudit],
})
export class PlatformModule {}
