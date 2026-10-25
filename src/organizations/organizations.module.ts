import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PermissionDependencyTypeormEntity } from './infra/db/permission-dependency.entity.js';
import { PermissionTypeormEntity } from './infra/db/permission.entity.js';
import { RolePermissionTypeormEntity } from './infra/db/role-permission.entity.js';
import { RoleTypeormEntity } from './infra/db/role.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PermissionTypeormEntity,
      PermissionDependencyTypeormEntity,
      RoleTypeormEntity,
      RolePermissionTypeormEntity,
    ]),
  ],
})
export class OrganizationsModule {}
