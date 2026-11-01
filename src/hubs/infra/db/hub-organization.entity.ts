import {
  Check,
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
import type { HubLinkStatus } from '../../domain/hub-organization-link.js';
import { HubTypeormEntity } from './hub.entity.js';

// Vínculo Hub x organização (dois consentimentos). Tabela de ligação sincronizável: desvincular é status/lápide e
// voltar reaproveita a linha. RLS (migration CreateHubs): org_isolation (única via de escrita), leitura pelo
// membro ativo da organização, pelo dono do Hub (`hub_owner_user_id`, desnormalizado para a policy não consultar
// hubs, que consulta esta tabela: sem recursão) e pelo próprio Hub.
@Entity('hub_organization')
@Check(
  'ck_hub_organization_status',
  `"status" IN ('pending', 'approved', 'rejected', 'revoked')`,
)
@Check(
  'ck_hub_organization_owner_consent',
  `("owner_approved_at" IS NULL) = ("owner_approved_by_user_id" IS NULL)`,
)
@Check(
  'ck_hub_organization_org_consent',
  `("org_approved_at" IS NULL) = ("org_approved_by_user_id" IS NULL)`,
)
@Check(
  'ck_hub_organization_approved',
  `"status" <> 'approved' OR "owner_approved_at" IS NOT NULL`,
)
@Index('ix_hub_organization_sync_version', ['syncVersion'])
@Index('fk_hub_organization_organizations_idx', ['organizationId'])
@Index('fk_hub_organization_hubs_idx', ['hubId', 'hubOwnerUserId'])
@Index('fk_hub_organization_hub_owner_idx', ['hubOwnerUserId'])
@Index('fk_hub_organization_requested_by_idx', ['requestedByUserId'])
@Index('fk_hub_organization_owner_approved_by_idx', ['ownerApprovedByUserId'])
@Index('fk_hub_organization_org_approved_by_idx', ['orgApprovedByUserId'])
export class HubOrganizationTypeormEntity {
  @PrimaryColumn({ type: 'uuid' })
  hubId!: string;

  @PrimaryColumn({ type: 'uuid' })
  organizationId!: string;

  // Dono do Hub, desnormalizado; a FK composta garante que é o owner_user_id real.
  @Column({ type: 'uuid' })
  hubOwnerUserId!: string;

  @ManyToOne(() => HubTypeormEntity)
  @JoinColumn([
    {
      name: 'hub_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_hub_organization_hubs',
    },
    {
      name: 'hub_owner_user_id',
      referencedColumnName: 'ownerUserId',
      foreignKeyConstraintName: 'fk_hub_organization_hubs',
    },
  ])
  hub?: HubTypeormEntity;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_hub_organization_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: HubLinkStatus;

  @Column({ type: 'uuid' })
  requestedByUserId!: string;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'requested_by_user_id',
    foreignKeyConstraintName: 'fk_hub_organization_requested_by',
  })
  requestedBy?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  ownerApprovedByUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'owner_approved_by_user_id',
    foreignKeyConstraintName: 'fk_hub_organization_owner_approved_by',
  })
  ownerApprovedBy?: { id: string };

  @Column({ type: 'timestamptz', nullable: true })
  ownerApprovedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  orgApprovedByUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'org_approved_by_user_id',
    foreignKeyConstraintName: 'fk_hub_organization_org_approved_by',
  })
  orgApprovedBy?: { id: string };

  @Column({ type: 'timestamptz', nullable: true })
  orgApprovedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'bigint', insert: false, update: false })
  syncVersion!: string;
}
