import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import { CloudTermTypeormEntity } from './cloud-term.entity.js';

// Aceite do termo por organização, uma vez por versão: quem, quando, de que IP e o hash do texto aceito. Append-only
// (o runtime só tem SELECT/INSERT); RLS por organização.
@Entity('cloud_term_acceptances')
@Index(
  'uq_cloud_term_acceptances_org_version',
  ['organizationId', 'termVersion'],
  { unique: true },
)
@Index('fk_cloud_term_acceptances_users_idx', ['acceptedByUserId'])
@Index('fk_cloud_term_acceptances_cloud_terms_idx', ['termVersion'])
@Check('ck_cloud_term_acceptances_hash', `"term_hash" ~ '^[0-9a-f]{64}$'`)
export class CloudTermAcceptanceTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  // Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_cloud_term_acceptances_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'integer' })
  termVersion!: number;

  @ManyToOne(() => CloudTermTypeormEntity)
  @JoinColumn({
    name: 'term_version',
    referencedColumnName: 'version',
    foreignKeyConstraintName: 'fk_cloud_term_acceptances_cloud_terms',
  })
  term?: CloudTermTypeormEntity;

  @Column({ type: 'varchar', length: 64 })
  termHash!: string;

  @Column({ type: 'uuid' })
  acceptedByUserId!: string;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'accepted_by_user_id',
    foreignKeyConstraintName: 'fk_cloud_term_acceptances_users',
  })
  acceptedBy?: { id: string };

  @Column({ type: 'timestamptz' })
  acceptedAt!: Date;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip!: string | null;
}
