import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type { StorageObjectVersionTypeormEntity } from './storage-object-version.entity.js';

// Objeto do backup de um espaço (spec storage-backup §4.1). O id é o `objectId` gerado pelo Hub (sem default). Só
// ids: nunca nome, tipo ou caminho de arquivo. Lápide = apagado (a última versão fica em `current_version_id`, na
// lixeira). Dado de cliente: RLS por organização (migration CreateStorageIndex); sem sync_version (o Hub lista pelo
// endpoint do índice).
@Entity('storage_objects')
// Alvo das FKs compostas (versão -> objeto da mesma organização).
@Unique('uq_storage_objects_id_organization', ['id', 'organizationId'])
@Index('fk_storage_objects_organizations_idx', ['organizationId'])
@Index('fk_storage_objects_spaces_idx', ['spaceId'])
@Index('fk_storage_objects_current_version_idx', ['currentVersionId'])
export class StorageObjectTypeormEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_storage_objects_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  // Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_storage_objects_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_storage_objects_spaces',
    },
  ])
  space?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  currentVersionId!: string | null;

  // Alvo por nome: as duas entidades se referenciam (import circular em ESM).
  @ManyToOne('StorageObjectVersionTypeormEntity')
  @JoinColumn([
    {
      name: 'current_version_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_storage_objects_current_version',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_storage_objects_current_version',
    },
  ])
  currentVersion?: StorageObjectVersionTypeormEntity;
}
