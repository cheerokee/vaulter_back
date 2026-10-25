import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { SyncableTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { HubLinkPolicy } from '../../domain/organization.js';

// RLS (migrations CreateOrganizations + HardenOrganizationsRls): visível com `app.organization_id = id` ou
// se o `app.user_id` for membro ativo (EXISTS em user_organization); INSERT e UPDATE só com
// `app.organization_id` igual ao id.
@Entity('organizations')
@Check(
  'ck_organizations_hub_link_policy',
  `"hub_link_policy" IN ('any_member_hub', 'admin_approved')`,
)
@Check(
  'ck_organizations_personal_owner',
  `"is_personal" = ("personal_owner_user_id" IS NOT NULL)`,
)
@Index('ix_organizations_sync_version', ['syncVersion'])
@Index('uq_organizations_personal_owner', ['personalOwnerUserId'], {
  unique: true,
  where: '"personal_owner_user_id" IS NOT NULL',
})
export class OrganizationTypeormEntity extends SyncableTypeormEntity {
  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'boolean', default: false })
  isPersonal!: boolean;

  @Column({ type: 'varchar', length: 20, default: 'any_member_hub' })
  hubLinkPolicy!: HubLinkPolicy;

  @Column({ type: 'varchar', length: 50, default: 'free' })
  plan!: string;

  @Column({ type: 'text', nullable: true })
  recoveryPublicKey!: string | null;

  @Column({ type: 'uuid', nullable: true })
  personalOwnerUserId!: string | null;

  // FK para users só como metadado (migration:generate). Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'personal_owner_user_id',
    foreignKeyConstraintName: 'fk_organizations_personal_owner',
  })
  personalOwner?: { id: string };
}
