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

// Tabela de ligação: chave composta, sem id.
@Entity('permission_dependency')
@Index('ix_permission_dependency_sync_version', ['syncVersion'])
@Index('fk_permission_dependency_requires_idx', ['requiresPermissionId'])
export class PermissionDependencyTypeormEntity {
  @PrimaryColumn({ type: 'uuid' })
  permissionId!: string;

  @PrimaryColumn({ type: 'uuid' })
  requiresPermissionId!: string;

  @ManyToOne(() => PermissionTypeormEntity)
  @JoinColumn({
    name: 'permission_id',
    foreignKeyConstraintName: 'fk_permission_dependency_permissions',
  })
  permission?: PermissionTypeormEntity;

  @ManyToOne(() => PermissionTypeormEntity)
  @JoinColumn({
    name: 'requires_permission_id',
    foreignKeyConstraintName: 'fk_permission_dependency_requires',
  })
  requires?: PermissionTypeormEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'bigint', insert: false, update: false })
  syncVersion!: string;
}
