import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformAuditLogTypeormEntity } from './infra/db/platform-audit-log.entity.js';
import { PlatformPermissionTypeormEntity } from './infra/db/platform-permission.entity.js';
import { PlatformRolePermissionTypeormEntity } from './infra/db/platform-role-permission.entity.js';
import { PlatformRoleTypeormEntity } from './infra/db/platform-role.entity.js';
import { PlatformSupportRequestTypeormEntity } from './infra/db/platform-support-request.entity.js';
import { UserPlatformRoleTypeormEntity } from './infra/db/user-platform-role.entity.js';

// Papéis da equipe da plataforma (spec docs/superpowers/specs/2026-11-07-platform-roles-design.md). Depende de
// identity, organizations e hubs só pelo que eles exportam; nenhum deles importa `platform`.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlatformRoleTypeormEntity,
      PlatformPermissionTypeormEntity,
      PlatformRolePermissionTypeormEntity,
      UserPlatformRoleTypeormEntity,
      PlatformSupportRequestTypeormEntity,
      PlatformAuditLogTypeormEntity,
    ]),
  ],
})
export class PlatformModule {}
