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
import { PlatformRoleTypeormEntity } from './platform-role.entity.js';

// Papel da plataforma de uma pessoa da equipe. Retirar = lápide (deleted_at); dar de novo limpa o deleted_at da
// mesma linha (chave composta). O runtime tem SELECT/INSERT/UPDATE, sem DELETE.
@Entity('user_platform_role')
@Index('fk_user_platform_role_platform_roles_idx', ['platformRoleId'])
export class UserPlatformRoleTypeormEntity {
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @PrimaryColumn({ type: 'uuid' })
  platformRoleId!: string;

  // Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_user_platform_role_users',
  })
  user?: { id: string };

  @ManyToOne(() => PlatformRoleTypeormEntity)
  @JoinColumn({
    name: 'platform_role_id',
    foreignKeyConstraintName: 'fk_user_platform_role_platform_roles',
  })
  platformRole?: PlatformRoleTypeormEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
