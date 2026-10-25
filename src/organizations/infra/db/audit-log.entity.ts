import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { PermissionScope } from '../../domain/rbac-catalog.js';
import { OrganizationTypeormEntity } from './organization.entity.js';

export type AuditResult = 'success' | 'denied' | 'error' | 'hub_offline';

// Só de acréscimo: o papel de runtime tem INSERT e SELECT (sem UPDATE nem DELETE). Completa como no DER; as
// FKs para app_installations, spaces e hubs entram nas migrations desses módulos. RLS por organization_id.
@Entity('audit_logs')
@Check(
  'ck_audit_logs_scope_type',
  `"scope_type" IS NULL OR "scope_type" IN ('organization', 'space', 'hub')`,
)
@Check(
  'ck_audit_logs_result',
  `"result" IN ('success', 'denied', 'error', 'hub_offline')`,
)
@Index('ix_audit_logs_organization_created', ['organizationId', 'createdAt'])
@Index('fk_audit_logs_app_installations_idx', ['appInstallationId'])
@Index('fk_audit_logs_users_idx', ['userId'])
@Index('fk_audit_logs_spaces_idx', ['spaceId'])
@Index('fk_audit_logs_hubs_idx', ['hubId'])
export class AuditLogTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne(() => OrganizationTypeormEntity)
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_audit_logs_organizations',
  })
  organization?: OrganizationTypeormEntity;

  // FK para app_installations: módulo de integração.
  @Column({ type: 'uuid', nullable: true })
  appInstallationId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_audit_logs_users',
  })
  user?: { id: string };

  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  scopeType!: PermissionScope | null;

  // FK para spaces: módulo de espaços.
  @Column({ type: 'uuid', nullable: true })
  spaceId!: string | null;

  // FK para hubs: módulo de hubs.
  @Column({ type: 'uuid', nullable: true })
  hubId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  result!: AuditResult;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: object | null;
}
