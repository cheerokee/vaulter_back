import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PermissionTypeormEntity } from './permission.entity.js';
import { RoleTypeormEntity } from './role.entity.js';

// Tabela de ligação: chave composta, sem id.
@Entity('role_permission')
@Index('ix_role_permission_sync_version', ['syncVersion'])
@Index('fk_role_permission_permissions_idx', ['permissionId'])
export class RolePermissionTypeormEntity {
  @PrimaryColumn({ type: 'uuid' })
  roleId!: string;

  @PrimaryColumn({ type: 'uuid' })
  permissionId!: string;

  @ManyToOne(() => RoleTypeormEntity)
  @JoinColumn({
    name: 'role_id',
    foreignKeyConstraintName: 'fk_role_permission_roles',
  })
  role?: RoleTypeormEntity;

  @ManyToOne(() => PermissionTypeormEntity)
  @JoinColumn({
    name: 'permission_id',
    foreignKeyConstraintName: 'fk_role_permission_permissions',
  })
  permission?: PermissionTypeormEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'bigint', insert: false, update: false })
  syncVersion!: string;
}
