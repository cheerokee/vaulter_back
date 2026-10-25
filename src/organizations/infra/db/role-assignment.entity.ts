import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { SyncableTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { PermissionScope } from '../../domain/rbac-catalog.js';
import { OrganizationTypeormEntity } from './organization.entity.js';
import { RoleTypeormEntity } from './role.entity.js';

export type ApprovalStatus =
  'not_required' | 'pending' | 'approved' | 'rejected';

// Completa como no DER. Quem: exatamente um de user_id / room_hub_id / app_installation_id. As colunas de
// Hub e instalação já existem (nulas); as FKs para hubs e app_installations entram nas migrations desses
// módulos (a de spaces entrou na CreateSpaces). RLS por organization_id, que vale também para as linhas de
// espaço (elas levam organization_id: ck_role_assignments_space_scope) + leitura das próprias atribuições
// (`user_id = app.user_id`). Uma atribuição de espaço ativa por pessoa em cada espaço.
@Entity('role_assignments')
@Check(
  'ck_role_assignments_scope_type',
  `"scope_type" IN ('organization', 'space', 'hub')`,
)
@Check(
  'ck_role_assignments_approval_status',
  `"approval_status" IN ('not_required', 'pending', 'approved', 'rejected')`,
)
@Check(
  'ck_role_assignments_subject',
  `num_nonnulls("user_id", "room_hub_id", "app_installation_id") = 1`,
)
@Check(
  'ck_role_assignments_organization_scope',
  `"scope_type" <> 'organization' OR "organization_id" IS NOT NULL`,
)
@Check(
  'ck_role_assignments_space_scope',
  `"scope_type" <> 'space' OR ("space_id" IS NOT NULL AND "organization_id" IS NOT NULL)`,
)
@Index('ix_role_assignments_sync_version', ['syncVersion'])
@Index('fk_role_assignments_roles_idx', ['roleId'])
@Index('ix_role_assignments_user_scope', ['userId', 'scopeType'])
@Index('fk_role_assignments_room_hub_idx', ['roomHubId'])
@Index('fk_role_assignments_organizations_idx', ['organizationId'])
@Index('fk_role_assignments_spaces_idx', ['spaceId'])
@Index('fk_role_assignments_hubs_idx', ['hubId'])
@Index('fk_role_assignments_granted_by_idx', ['grantedByUserId'])
@Index('fk_role_assignments_app_installations_idx', ['appInstallationId'])
@Index('fk_role_assignments_approved_by_idx', ['approvedByUserId'])
// Um papel de organização ativo por membro (lockOrgAdmins devolve ids sem repetição).
@Index('uq_role_assignments_org_user', ['organizationId', 'userId'], {
  unique: true,
  where: `"scope_type" = 'organization' AND "deleted_at" IS NULL`,
})
@Index('uq_role_assignments_space_user', ['spaceId', 'userId'], {
  unique: true,
  where: `"scope_type" = 'space' AND "deleted_at" IS NULL`,
})
export class RoleAssignmentTypeormEntity extends SyncableTypeormEntity {
  @Column({ type: 'uuid' })
  roleId!: string;

  @ManyToOne(() => RoleTypeormEntity)
  @JoinColumn({
    name: 'role_id',
    foreignKeyConstraintName: 'fk_role_assignments_roles',
  })
  role?: RoleTypeormEntity;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_role_assignments_users',
  })
  user?: { id: string };

  // FK para hubs: módulo de hubs.
  @Column({ type: 'uuid', nullable: true })
  roomHubId!: string | null;

  // FK para app_installations: módulo de integração.
  @Column({ type: 'uuid', nullable: true })
  appInstallationId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  scopeType!: PermissionScope;

  @Column({ type: 'uuid', nullable: true })
  organizationId!: string | null;

  @ManyToOne(() => OrganizationTypeormEntity)
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_role_assignments_organizations',
  })
  organization?: OrganizationTypeormEntity;

  @Column({ type: 'uuid', nullable: true })
  spaceId!: string | null;

  // Alvo por nome: um módulo não importa a infra/ do outro (o spaces depende do organizations, não o contrário).
  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn({
    name: 'space_id',
    foreignKeyConstraintName: 'fk_role_assignments_spaces',
  })
  space?: { id: string };

  // FK para hubs: módulo de hubs.
  @Column({ type: 'uuid', nullable: true })
  hubId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  grantedByUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'granted_by_user_id',
    foreignKeyConstraintName: 'fk_role_assignments_granted_by',
  })
  grantedBy?: { id: string };

  @Column({ type: 'varchar', length: 20, default: 'not_required' })
  approvalStatus!: ApprovalStatus;

  @Column({ type: 'uuid', nullable: true })
  approvedByUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'approved_by_user_id',
    foreignKeyConstraintName: 'fk_role_assignments_approved_by',
  })
  approvedBy?: { id: string };

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;
}
