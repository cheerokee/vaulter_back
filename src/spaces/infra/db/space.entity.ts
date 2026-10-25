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

export type CloudMode = 'encrypted_backup' | 'active_cloud';

// Sincronizável. RLS por organization_id (migration CreateSpaces, policy org_isolation).
// key_rotation_required: flag do backend (troca de chave pendente depois da saída de um membro).
@Entity('spaces')
// Alvo das FKs compostas (filho_id, organization_id): o pai precisa ser da mesma organização.
@Unique('uq_spaces_id_organization', ['id', 'organizationId'])
@Check(
  'ck_spaces_cloud_mode',
  `"cloud_mode" IN ('encrypted_backup', 'active_cloud')`,
)
@Check('ck_spaces_current_key_version', `"current_key_version" >= 1`)
@Index('ix_spaces_sync_version', ['syncVersion'])
@Index('fk_spaces_organizations_idx', ['organizationId'])
export class SpaceTypeormEntity extends SyncableTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  // Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_spaces_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  // v1: só encrypted_backup.
  @Column({ type: 'varchar', length: 20, default: 'encrypted_backup' })
  cloudMode!: CloudMode;

  // v1: só o campo; todos permitidos.
  @Column({ type: 'boolean', default: true })
  allowOnlineLlm!: boolean;

  @Column({ type: 'integer', default: 1 })
  currentKeyVersion!: number;

  @Column({ type: 'boolean', default: false })
  keyRotationRequired!: boolean;
}
