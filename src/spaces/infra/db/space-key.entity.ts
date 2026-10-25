import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Unique,
} from 'typeorm';
import { SyncableTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import { SpaceTypeormEntity } from './space.entity.js';

// Uma linha por versão da chave do espaço. Sincronizável. organization_id desnormalizado para o RLS
// (policy org_isolation). recovery_wrapped_key é sobrescrita ao retrancar para um kit novo.
@Entity('space_keys')
// Alvo das FKs compostas (filho_id, organization_id): o pai precisa ser da mesma organização.
@Unique('uq_space_keys_id_organization', ['id', 'organizationId'])
@Check('ck_space_keys_version', `"version" >= 1`)
@Index('ix_space_keys_sync_version', ['syncVersion'])
@Index('uq_space_keys_space_version', ['spaceId', 'version'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
@Index('fk_space_keys_organizations_idx', ['organizationId'])
export class SpaceKeyTypeormEntity extends SyncableTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_space_keys_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  @ManyToOne(() => SpaceTypeormEntity)
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_space_keys_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_space_keys_spaces',
    },
  ])
  space?: SpaceTypeormEntity;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'text' })
  recoveryWrappedKey!: string;

  @Column({ type: 'varchar', length: 64 })
  recoveryKeyFingerprint!: string;
}
