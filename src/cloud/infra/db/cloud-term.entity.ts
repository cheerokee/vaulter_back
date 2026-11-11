import { Check, Column, Entity, Unique } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';

// Versões publicadas do termo da nuvem ativa (spec active-cloud §4.1). Dado do servidor (sem organization_id nem
// RLS), publicado só por migration, como os catálogos: o runtime só lê (migration CreateCloudActivation revoga
// INSERT/UPDATE). `hash` = SHA-256 (hex) do texto em UTF-8; o termo atual é a maior versão.
@Entity('cloud_terms')
@Unique('uq_cloud_terms_version', ['version'])
@Check('ck_cloud_terms_version', `"version" >= 1`)
@Check('ck_cloud_terms_hash', `"hash" ~ '^[0-9a-f]{64}$'`)
export class CloudTermTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'varchar', length: 64 })
  hash!: string;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'timestamptz' })
  publishedAt!: Date;
}
