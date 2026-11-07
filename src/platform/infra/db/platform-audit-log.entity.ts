import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import { PlatformSupportRequestTypeormEntity } from './platform-support-request.entity.js';

export type PlatformAuditResult = 'success' | 'denied' | 'error';

// Trilha da equipe (spec §4.5), só de acréscimo: o runtime tem INSERT e SELECT (sem UPDATE nem DELETE). Sem RLS e
// sem sync_version. user_id nulo = comando de linha (ex.: platform:grant-admin).
@Entity('platform_audit_logs')
@Check(
  'ck_platform_audit_logs_result',
  `"result" IN ('success', 'denied', 'error')`,
)
@Index('ix_platform_audit_logs_created', ['createdAt'])
@Index('fk_platform_audit_logs_users_idx', ['userId'])
@Index('fk_platform_audit_logs_support_requests_idx', ['supportRequestId'])
@Index('fk_platform_audit_logs_target_user_idx', ['targetUserId'])
@Index('fk_platform_audit_logs_target_hub_idx', ['targetHubId'])
@Index('fk_platform_audit_logs_target_organization_idx', [
  'targetOrganizationId',
])
export class PlatformAuditLogTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  // Alvos por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_platform_audit_logs_users',
  })
  user?: { id: string };

  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'uuid', nullable: true })
  supportRequestId!: string | null;

  @ManyToOne(() => PlatformSupportRequestTypeormEntity)
  @JoinColumn({
    name: 'support_request_id',
    foreignKeyConstraintName: 'fk_platform_audit_logs_support_requests',
  })
  supportRequest?: PlatformSupportRequestTypeormEntity;

  @Column({ type: 'uuid', nullable: true })
  targetUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'target_user_id',
    foreignKeyConstraintName: 'fk_platform_audit_logs_target_user',
  })
  targetUser?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  targetHubId!: string | null;

  @ManyToOne('HubTypeormEntity')
  @JoinColumn({
    name: 'target_hub_id',
    foreignKeyConstraintName: 'fk_platform_audit_logs_target_hub',
  })
  targetHub?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  targetOrganizationId!: string | null;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'target_organization_id',
    foreignKeyConstraintName: 'fk_platform_audit_logs_target_organization',
  })
  targetOrganization?: { id: string };

  @Column({ type: 'varchar', length: 20 })
  result!: PlatformAuditResult;

  // Sem segredo, token, prova de reautenticação nem cópia trancada.
  @Column({ type: 'jsonb', nullable: true })
  metadata!: object | null;
}
