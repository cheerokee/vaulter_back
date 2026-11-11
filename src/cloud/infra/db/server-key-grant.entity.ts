import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';

// Cópia trancada de uma versão da chave do espaço para a chave do servidor (`0x01 ‖ crypto_box_seal`, 108 chars),
// uma por versão, enquanto o espaço está em nuvem ativa. Aberta, dá a chave do espaço: desligar a nuvem APAGA as
// linhas de verdade (DELETE físico, sem lápide): exceção documentada à regra do soft delete, como `rate_limit_hits`;
// só aqui (e nas tabelas legíveis da nuvem) o `app_runtime` tem DELETE. Não sincroniza. RLS por organização.
@Entity('cloud_space_key_grants')
@Index('uq_cloud_space_key_grants_space_version', ['spaceId', 'keyVersion'], {
  unique: true,
})
@Index('uq_cloud_space_key_grants_space_key', ['spaceKeyId'], {
  unique: true,
})
@Index('fk_cloud_space_key_grants_spaces_idx', ['spaceId', 'organizationId'])
@Index('fk_cloud_space_key_grants_organizations_idx', ['organizationId'])
@Check('ck_cloud_space_key_grants_version', `"key_version" >= 1`)
@Check(
  'ck_cloud_space_key_grants_wrapped_key',
  `"wrapped_key" ~ '^[A-Za-z0-9_-]{108}$'`,
)
export class ServerKeyGrantTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_cloud_space_key_grants_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_cloud_space_key_grants_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_cloud_space_key_grants_spaces',
    },
  ])
  space?: { id: string };

  @Column({ type: 'uuid' })
  spaceKeyId!: string;

  @ManyToOne('SpaceKeyTypeormEntity')
  @JoinColumn([
    {
      name: 'space_key_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_cloud_space_key_grants_space_keys',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_cloud_space_key_grants_space_keys',
    },
  ])
  spaceKey?: { id: string };

  @Column({ type: 'integer' })
  keyVersion!: number;

  @Column({ type: 'varchar', length: 108 })
  wrappedKey!: string;
}
