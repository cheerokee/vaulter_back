import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Unique,
} from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type {
  CloudFileSkipReason,
  CloudFileStatus,
} from '../../domain/cloud-file.js';

// Arquivo de um espaço em nuvem ativa, como os manifestos o descrevem (spec active-cloud §4.2; contrato em
// docs/hubs/space-manifest.md): nome, caminho, tipo e origem (LEGÍVEIS: nunca em log) e as versões do backup de cada
// parte (`part_object_ids`/`part_version_ids`, na ordem) que foram ou serão indexadas. Desligar a nuvem APAGA as linhas
// de verdade (DELETE físico, com os trechos, FK em cascata): exceção documentada à regra do soft delete, como
// `cloud_space_key_grants`. Não sincroniza. RLS por organização.
@Entity('cloud_files')
// Alvo da FK composta dos trechos (trecho -> arquivo da mesma organização).
@Unique('uq_cloud_files_id_organization', ['id', 'organizationId'])
@Index('uq_cloud_files_space_file', ['spaceId', 'fileId'], { unique: true })
@Index('fk_cloud_files_spaces_idx', ['spaceId', 'organizationId'])
@Index('fk_cloud_files_organizations_idx', ['organizationId'])
@Check('ck_cloud_files_status', `"status" IN ('pending', 'indexed', 'skipped')`)
@Check('ck_cloud_files_manifest', `"manifest" IN ('hub', 'cloud')`)
@Check(
  'ck_cloud_files_source_kind',
  `"source_kind" IN ('file', 'connector', 'cloud')`,
)
@Check(
  'ck_cloud_files_connector',
  `("source_kind" = 'connector') = ("connector" IS NOT NULL)`,
)
@Check(
  'ck_cloud_files_skip_reason',
  `("status" = 'skipped') = ("skip_reason" IS NOT NULL)`,
)
@Check(
  'ck_cloud_files_parts',
  `cardinality("part_object_ids") = cardinality("part_version_ids")`,
)
@Check('ck_cloud_files_chunk_count', `"chunk_count" >= 0`)
export class CloudFileTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_cloud_files_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_cloud_files_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_cloud_files_spaces',
    },
  ])
  space?: { id: string };

  /** The manifest's `fileId` (stable across versions of the file). */
  @Column({ type: 'uuid' })
  fileId!: string;

  @Column({ type: 'varchar', length: 10 })
  manifest!: 'hub' | 'cloud';

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  path!: string | null;

  @Column({ type: 'varchar', length: 255 })
  mediaType!: string;

  @Column({ type: 'varchar', length: 20 })
  sourceKind!: 'file' | 'connector' | 'cloud';

  @Column({ type: 'varchar', length: 100, nullable: true })
  connector!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  modifiedAt!: Date | null;

  @Column({ type: 'uuid', array: true })
  partObjectIds!: string[];

  @Column({ type: 'uuid', array: true })
  partVersionIds!: string[];

  @Column({ type: 'varchar', length: 20 })
  status!: CloudFileStatus;

  @Column({ type: 'varchar', length: 40, nullable: true })
  skipReason!: CloudFileSkipReason | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  embeddingModel!: string | null;

  @Column({ type: 'integer', default: 0 })
  chunkCount!: number;

  @Column({ type: 'timestamptz', nullable: true })
  indexedAt!: Date | null;
}
