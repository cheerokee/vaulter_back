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
import { HubTypeormEntity } from './hub.entity.js';

// Espaço que está num Hub. Tabela de ligação sincronizável: tirar é lápide, pôr de novo revive a linha.
// organization_id desnormalizado com FK composta (space_id, organization_id) -> spaces (a checagem de FK ignora o
// RLS). RLS (migration CreateHubs): org_isolation (única via de escrita), leitura pelo membro ativo da
// organização, pelo dono do Hub e pelo próprio Hub.
@Entity('hub_space')
@Index('ix_hub_space_sync_version', ['syncVersion'])
@Index('fk_hub_space_spaces_idx', ['spaceId', 'organizationId'])
@Index('fk_hub_space_organizations_idx', ['organizationId'])
@Index('fk_hub_space_added_by_idx', ['addedByUserId'])
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
