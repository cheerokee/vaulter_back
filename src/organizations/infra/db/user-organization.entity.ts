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
import { OrganizationTypeormEntity } from './organization.entity.js';

// Tabela de ligação (chave composta). Sair = lápide; voltar limpa a lápide na mesma linha.
// RLS: policy da organização + leitura das próprias linhas (`user_id = app.user_id`).
@Entity('user_organization')
@Index('ix_user_organization_sync_version', ['syncVersion'])
@Index('fk_user_organization_users_idx', ['userId'])
export class UserOrganizationTypeormEntity {
  @PrimaryColumn({ type: 'uuid' })
  organizationId!: string;

  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => OrganizationTypeormEntity)
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_user_organization_organizations',
  })
  organization?: OrganizationTypeormEntity;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_user_organization_users',
  })
  user?: { id: string };

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'bigint', insert: false, update: false })
  syncVersion!: string;
}
