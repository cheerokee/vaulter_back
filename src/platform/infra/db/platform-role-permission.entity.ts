import {
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PlatformPermissionTypeormEntity } from './platform-permission.entity.js';
import { PlatformRoleTypeormEntity } from './platform-role.entity.js';

// Ligação papel -> permissão do catálogo da plataforma: chave composta, sem id, sem sync_version. O runtime só lê.
@Entity('platform_role_permission')
@Index('fk_platform_role_permission_platform_permissions_idx', [
  'platformPermissionId',
])
export class PlatformRolePermissionTypeormEntity {
  @PrimaryColumn({ type: 'uuid' })
  platformRoleId!: string;

  @PrimaryColumn({ type: 'uuid' })
  platformPermissionId!: string;

  @ManyToOne(() => PlatformRoleTypeormEntity)
  @JoinColumn({
    name: 'platform_role_id',
    foreignKeyConstraintName: 'fk_platform_role_permission_platform_roles',
  })
  platformRole?: PlatformRoleTypeormEntity;

  @ManyToOne(() => PlatformPermissionTypeormEntity)
  @JoinColumn({
    name: 'platform_permission_id',
    foreignKeyConstraintName:
      'fk_platform_role_permission_platform_permissions',
  })
  platformPermission?: PlatformPermissionTypeormEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
