import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import { CloudTermTypeormEntity } from './cloud-term.entity.js';

// Um ciclo da nuvem ativa de um espaço: autorizado (quem decide) -> ativo (o Gestor mandou a cópia da chave). Desligar
// encerra o ciclo com lápide (`deleted_at` + quem desligou); autorizar de novo cria outro ciclo (histórico de quem
// autorizou/ligou). No máximo um ciclo vivo por espaço. Nada legível aqui. RLS por organização.
@Entity('cloud_space_activations')
@Index('uq_cloud_space_activations_live_space', ['spaceId'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
@Index('fk_cloud_space_activations_spaces_idx', ['spaceId', 'organizationId'])
@Index('fk_cloud_space_activations_organizations_idx', ['organizationId'])
@Check(
  'ck_cloud_space_activations_state',
  `"state" IN ('authorized', 'active')`,
)
@Check(
  'ck_cloud_space_activations_activated',
  `("state" = 'active') = ("activated_at" IS NOT NULL) AND ("activated_at" IS NULL) = ("activated_by_user_id" IS NULL)`,
)
@Check(
  'ck_cloud_space_activations_deactivated',
  `("deactivated_by_user_id" IS NULL) OR ("deleted_at" IS NOT NULL)`,
)
export class SpaceActivationTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_cloud_space_activations_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  // FK composta (filho_id, organization_id): a checagem de FK ignora o RLS.
  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_cloud_space_activations_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_cloud_space_activations_spaces',
    },
  ])
  space?: { id: string };

  @Column({ type: 'varchar', length: 20 })
  state!: 'authorized' | 'active';

  @Column({ type: 'integer' })
  termVersion!: number;

  @ManyToOne(() => CloudTermTypeormEntity)
  @JoinColumn({
    name: 'term_version',
    referencedColumnName: 'version',
    foreignKeyConstraintName: 'fk_cloud_space_activations_cloud_terms',
  })
  term?: CloudTermTypeormEntity;

  @Column({ type: 'uuid' })
  authorizedByUserId!: string;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'authorized_by_user_id',
    foreignKeyConstraintName: 'fk_cloud_space_activations_authorized_by',
  })
  authorizedBy?: { id: string };

  @Column({ type: 'timestamptz' })
  authorizedAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  activatedByUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'activated_by_user_id',
    foreignKeyConstraintName: 'fk_cloud_space_activations_activated_by',
  })
  activatedBy?: { id: string };

  @Column({ type: 'timestamptz', nullable: true })
  activatedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  deactivatedByUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'deactivated_by_user_id',
    foreignKeyConstraintName: 'fk_cloud_space_activations_deactivated_by',
  })
  deactivatedBy?: { id: string };
}
