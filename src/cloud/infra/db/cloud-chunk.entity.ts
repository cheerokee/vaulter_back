import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';

/** Dimensions of `nomic-embed-text` (the Hub's model; spec active-cloud §3). */
export const CHUNK_EMBEDDING_DIMENSIONS = 768;

// Trecho indexado de um arquivo de um espaço em nuvem ativa (spec active-cloud §4.2): texto (LEGÍVEL: nunca em log),
// embedding `vector(768)` e o modelo que o calculou; `object_id`/`version_id` = a primeira parte do arquivo e a versão do
// backup dela (a lista completa fica em `cloud_files`). Busca por similaridade de cosseno pelo índice HNSW
// `ix_cloud_chunks_embedding_hnsw` (criado na migration, fora dos metadados: o TypeORM não descreve `USING hnsw`).
// Desligar a nuvem APAGA as linhas de verdade (exceção documentada, como `cloud_space_key_grants`). RLS por
// organização.
@Entity('cloud_chunks')
@Index('uq_cloud_chunks_file_position', ['cloudFileId', 'position'], {
  unique: true,
})
@Index('fk_cloud_chunks_files_idx', ['cloudFileId', 'organizationId'])
@Index('fk_cloud_chunks_spaces_idx', ['spaceId', 'organizationId'])
@Index('fk_cloud_chunks_organizations_idx', ['organizationId'])
@Index('ix_cloud_chunks_embedding_hnsw', { synchronize: false })
@Check('ck_cloud_chunks_position', `"position" >= 0`)
export class CloudChunkTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_cloud_chunks_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_cloud_chunks_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_cloud_chunks_spaces',
    },
  ])
  space?: { id: string };

  @Column({ type: 'uuid' })
  cloudFileId!: string;

  // Apagar o arquivo apaga os trechos (DELETE físico ao desligar ou quando o arquivo sai do manifesto).
  @ManyToOne('CloudFileTypeormEntity', { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'cloud_file_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_cloud_chunks_files',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_cloud_chunks_files',
    },
  ])
  cloudFile?: { id: string };

  @Column({ type: 'uuid' })
  fileId!: string;

  @Column({ type: 'uuid' })
  objectId!: string;

  @Column({ type: 'uuid' })
  versionId!: string;

  @Column({ type: 'integer' })
  position!: number;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'vector', length: CHUNK_EMBEDDING_DIMENSIONS })
  embedding!: number[];

  @Column({ type: 'varchar', length: 100 })
  embeddingModel!: string;
}
