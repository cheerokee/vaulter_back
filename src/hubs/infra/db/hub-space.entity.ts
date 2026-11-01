import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { HubOrganizationTypeormEntity } from './hub-organization.entity.js';
import { HubTypeormEntity } from './hub.entity.js';

// Espaço que está num Hub. Tabela de ligação sincronizável: tirar é lápide, pôr de novo revive a linha.
// organization_id desnormalizado com FK composta (space_id, organization_id) -> spaces (a checagem de FK ignora o
// RLS) e FK composta (hub_id, organization_id) -> hub_organization (só entra espaço de organização vinculada).
// RLS (CreateHubs + HardenHubsRls): org_isolation (única via de escrita), leitura pelo dono do Hub e pelo próprio
// Hub, este só com o vínculo aprovado da organização da linha.
@Entity('hub_space')
@Index('ix_hub_space_sync_version', ['syncVersion'])
@Index('fk_hub_space_spaces_idx', ['spaceId', 'organizationId'])
@Index('fk_hub_space_organizations_idx', ['organizationId'])
@Index('fk_hub_space_added_by_idx', ['addedByUserId'])
@Index('fk_hub_space_hub_organization_idx', ['hubId', 'organizationId'])
export class HubSpaceTypeormEntity {
  @PrimaryColumn({ type: 'uuid' })
  hubId!: string;

  @PrimaryColumn({ type: 'uuid' })
  spaceId!: string;

  @ManyToOne(() => HubTypeormEntity)
  @JoinColumn({ name: 'hub_id', foreignKeyConstraintName: 'fk_hub_space_hubs' })
  hub?: HubTypeormEntity;

  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne(() => HubOrganizationTypeormEntity)
  @JoinColumn([
    {
      name: 'hub_id',
      referencedColumnName: 'hubId',
      foreignKeyConstraintName: 'fk_hub_space_hub_organization',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_hub_space_hub_organization',
    },
  ])
  link?: HubOrganizationTypeormEntity;

  // Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_hub_space_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_hub_space_spaces',
    },
  ])
  space?: { id: string };

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_hub_space_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  addedByUserId!: string;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'added_by_user_id',
    foreignKeyConstraintName: 'fk_hub_space_added_by',
  })
  addedBy?: { id: string };

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'bigint', insert: false, update: false })
  syncVersion!: string;
}
