import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { SyncableTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import { SpaceKeyTypeormEntity } from './space-key.entity.js';

// Cópia trancada da chave de uma versão: para exatamente um de usuário, hub ou instalação. Sincronizável;
// remover é lápide, e quem volta tem a lápide limpa na mesma linha. organization_id desnormalizado para o RLS.
// hub_id e app_installation_id nascem nulas e sem FK: as tabelas chegam nos módulos de hubs e de integração.
@Entity('space_key_grants')
@Check(
  'ck_space_key_grants_recipient',
  `num_nonnulls("user_id", "hub_id", "app_installation_id") = 1`,
)
@Index('ix_space_key_grants_sync_version', ['syncVersion'])
@Index('uq_space_key_grants_user', ['spaceKeyId', 'userId'], {
  unique: true,
  where: '"user_id" IS NOT NULL AND "deleted_at" IS NULL',
})
@Index('uq_space_key_grants_hub', ['spaceKeyId', 'hubId'], {
  unique: true,
  where: '"hub_id" IS NOT NULL AND "deleted_at" IS NULL',
})
@Index(
  'uq_space_key_grants_installation',
  ['spaceKeyId', 'appInstallationId'],
  {
    unique: true,
    where: '"app_installation_id" IS NOT NULL AND "deleted_at" IS NULL',
  },
)
@Index('fk_space_key_grants_organizations_idx', ['organizationId'])
@Index('fk_space_key_grants_users_idx', ['userId'])
@Index('fk_space_key_grants_hubs_idx', ['hubId'])
@Index('fk_space_key_grants_app_installations_idx', ['appInstallationId'])
export class SpaceKeyGrantTypeormEntity extends SyncableTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_space_key_grants_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceKeyId!: string;

  @ManyToOne(() => SpaceKeyTypeormEntity)
  @JoinColumn({
    name: 'space_key_id',
    foreignKeyConstraintName: 'fk_space_key_grants_space_keys',
  })
  spaceKey?: SpaceKeyTypeormEntity;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_space_key_grants_users',
  })
  user?: { id: string };

  // FK para hubs: módulo de hubs.
  @Column({ type: 'uuid', nullable: true })
  hubId!: string | null;

  // FK para app_installations: módulo de integração.
  @Column({ type: 'uuid', nullable: true })
  appInstallationId!: string | null;

  @Column({ type: 'text' })
  wrappedKey!: string;
}
