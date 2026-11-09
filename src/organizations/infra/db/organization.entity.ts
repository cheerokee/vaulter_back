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
// Janela de proteção depois de um admin nomeado pela plataforma: os três campos andam juntos (uma nomeação nova
// sobrescreve os três). Troca do kit: quando e quem andam juntos.
@Check(
  'ck_organizations_platform_appointment',
  `("platform_appointed_user_id" IS NULL) = ("platform_appointed_at" IS NULL) AND ("platform_appointed_at" IS NULL) = ("protected_until" IS NULL)`,
)
@Check(
  'ck_organizations_recovery_key_changed',
  `("recovery_key_changed_at" IS NULL) = ("recovery_key_changed_by_user_id" IS NULL)`,
)
@Check('ck_organizations_storage_quota_bytes', `"storage_quota_bytes" > 0`)
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

  @Column({ type: 'boolean', default: true })
  allowRoomSpaces!: boolean;

  @Column({ type: 'varchar', length: 50, default: 'free' })
  plan!: string;

  @Column({ type: 'text', nullable: true })
  recoveryPublicKey!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  recoveryKeyChangedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  recoveryKeyChangedByUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  platformAppointedUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  platformAppointedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  protectedUntil!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  personalOwnerUserId!: string | null;

  // Franquia de nuvem (bytes; bigint volta como string no driver pg, o mapper converte).
  @Column({ type: 'bigint', default: 53687091200 })
  storageQuotaBytes!: string;

  // FK para users só como metadado (migration:generate). Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'personal_owner_user_id',
    foreignKeyConstraintName: 'fk_organizations_personal_owner',
  })
  personalOwner?: { id: string };

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'recovery_key_changed_by_user_id',
    foreignKeyConstraintName: 'fk_organizations_recovery_key_changed_by',
  })
  recoveryKeyChangedBy?: { id: string };

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'platform_appointed_user_id',
    foreignKeyConstraintName: 'fk_organizations_platform_appointed_user',
  })
  platformAppointedUser?: { id: string };
}
