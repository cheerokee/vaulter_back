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
import type { BackupVersionStatus } from '../../domain/backup-object-version.js';
import type { StorageObjectTypeormEntity } from './storage-object.entity.js';

// Versão de um objeto do backup: nasce `pending` na intenção de envio (id uuid v7 do servidor = `uploadId`; reserva
// o tamanho até `upload_expires_at`), vira `committed` na confirmação (`s3_version_id`, `committed_at`) e `expired`
// quando uma intenção nova do mesmo objeto por quem envia a encerra. `superseded_at` = foi para a lixeira (30 dias);
// `purged` (`purged_at`) = apagada de vez da lixeira (o Gestor esvaziou, ou passou do limite de 10 versões antigas).
// Só ids, tamanho, sha256 do blob cifrado, versão da chave e quem enviou (um Hub OU uma pessoa). RLS por organização.
@Entity('storage_object_versions')
@Unique('uq_storage_object_versions_id_organization', ['id', 'organizationId'])
@Check(
  'ck_storage_object_versions_status',
  `"status" IN ('pending', 'committed', 'expired', 'purged')`,
)
@Check(
  'ck_storage_object_versions_uploader',
  `num_nonnulls("uploaded_by_hub_id", "uploaded_by_user_id") = 1`,
)
@Check('ck_storage_object_versions_size_bytes', `"size_bytes" > 0`)
@Check('ck_storage_object_versions_key_version', `"key_version" >= 1`)
@Check('ck_storage_object_versions_sha256', `"sha256" ~ '^[0-9a-f]{64}$'`)
@Check(
  'ck_storage_object_versions_committed',
  `("status" IN ('committed', 'purged')) = ("s3_version_id" IS NOT NULL AND "committed_at" IS NOT NULL)`,
)
@Check(
  'ck_storage_object_versions_purged',
  `("status" = 'purged') = ("purged_at" IS NOT NULL AND "superseded_at" IS NOT NULL)`,
)
@Index('fk_storage_object_versions_organizations_idx', ['organizationId'])
@Index('fk_storage_object_versions_objects_idx', ['objectId'])
@Index('fk_storage_object_versions_replaces_idx', ['replacesVersionId'])
@Index('fk_storage_object_versions_hubs_idx', ['uploadedByHubId'])
@Index('fk_storage_object_versions_users_idx', ['uploadedByUserId'])
// Uso do espaço (soma por status) e a lista de versões do espaço.
@Index('ix_storage_object_versions_space_status', ['spaceId', 'status'])
// Diário das gravações no S3 (a varredura do reparo procura as marcadas antigas).
@Index('ix_storage_object_versions_s3_write_started', ['s3WriteStartedAt'], {
  where: `"s3_write_started_at" IS NOT NULL`,
})
export class StorageObjectVersionTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_storage_object_versions_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_storage_object_versions_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_storage_object_versions_spaces',
    },
  ])
  space?: { id: string };

  @Column({ type: 'uuid' })
  objectId!: string;

  @ManyToOne('StorageObjectTypeormEntity')
  @JoinColumn([
    {
      name: 'object_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_storage_object_versions_objects',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_storage_object_versions_objects',
    },
  ])
  object?: StorageObjectTypeormEntity;

  @Column({ type: 'integer' })
  keyVersion!: number;

  // bigint volta como string no driver pg (o mapper converte com byteCount).
  @Column({ type: 'bigint' })
  sizeBytes!: string;

  @Column({ type: 'char', length: 64 })
  sha256!: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: BackupVersionStatus;

  @Column({ type: 'uuid', nullable: true })
  replacesVersionId!: string | null;

  @ManyToOne('StorageObjectVersionTypeormEntity')
  @JoinColumn([
    {
      name: 'replaces_version_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_storage_object_versions_replaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_storage_object_versions_replaces',
    },
  ])
  replacesVersion?: StorageObjectVersionTypeormEntity;

  // Id de versão do S3 (até 1024 bytes pela documentação da AWS).
  @Column({ type: 'varchar', length: 1024, nullable: true })
  s3VersionId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  uploadedByHubId!: string | null;

  @ManyToOne('HubTypeormEntity')
  @JoinColumn({
    name: 'uploaded_by_hub_id',
    foreignKeyConstraintName: 'fk_storage_object_versions_hubs',
  })
  uploadedByHub?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  uploadedByUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'uploaded_by_user_id',
    foreignKeyConstraintName: 'fk_storage_object_versions_users',
  })
  uploadedByUser?: { id: string };

  @Column({ type: 'timestamptz' })
  uploadExpiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  committedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  supersededAt!: Date | null;

  // Apagada de vez da lixeira (status `purged`; ver migration StorageTrashPurge), no relógio do banco.
  @Column({ type: 'timestamptz', nullable: true })
  purgedAt!: Date | null;

  // Diário (ver migration StorageWriteJournal): alguma tentativa de gravar no S3 por esta linha (cópia ou delete marker)
  // começou neste instante ou depois (relógio do banco), renovado para a tentativa mais recente. Nunca é limpo no
  // commit: só a varredura do reparo o limpa, e só quando tem mais de 60 min.
  @Column({ type: 'timestamptz', nullable: true })
  s3WriteStartedAt!: Date | null;
}
