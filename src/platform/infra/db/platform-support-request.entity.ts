import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type {
  PlatformSupportRequestStatus,
  PlatformSupportRequestType,
} from '../../domain/support-request.js';

// Pedido de suporte da equipe (spec §4.3). Só do backend: sem RLS e sem sync_version. O runtime tem
// SELECT/INSERT/UPDATE, sem DELETE. O alvo depende do tipo: desregistro forçado = só o Hub; nomear admin = a
// organização e a pessoa nomeada.
@Entity('platform_support_requests')
@Check(
  'ck_platform_support_requests_type',
  `"type" IN ('hub_force_deregister', 'org_appoint_admin')`,
)
@Check(
  'ck_platform_support_requests_status',
  `"status" IN ('pending', 'executed', 'rejected', 'expired', 'failed')`,
)
@Check(
  'ck_platform_support_requests_target',
  `("type" = 'hub_force_deregister' AND "target_hub_id" IS NOT NULL AND "target_organization_id" IS NULL AND "target_user_id" IS NULL) OR ("type" = 'org_appoint_admin' AND "target_hub_id" IS NULL AND "target_organization_id" IS NOT NULL AND "target_user_id" IS NOT NULL)`,
)
@Index('ix_platform_support_requests_status_created', ['status', 'createdAt'])
@Index('fk_platform_support_requests_requested_by_idx', ['requestedByUserId'])
@Index('fk_platform_support_requests_decided_by_idx', ['decidedByUserId'])
@Index('fk_platform_support_requests_target_hub_idx', ['targetHubId'])
@Index('fk_platform_support_requests_target_organization_idx', [
  'targetOrganizationId',
])
@Index('fk_platform_support_requests_target_user_idx', ['targetUserId'])
export class PlatformSupportRequestTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'varchar', length: 30 })
  type!: PlatformSupportRequestType;

  @Column({ type: 'varchar', length: 20 })
  status!: PlatformSupportRequestStatus;

  @Column({ type: 'uuid' })
  requestedByUserId!: string;

  // Alvos por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'requested_by_user_id',
    foreignKeyConstraintName: 'fk_platform_support_requests_requested_by',
  })
  requestedBy?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  targetHubId!: string | null;

  @ManyToOne('HubTypeormEntity')
  @JoinColumn({
    name: 'target_hub_id',
    foreignKeyConstraintName: 'fk_platform_support_requests_target_hub',
  })
  targetHub?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  targetOrganizationId!: string | null;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'target_organization_id',
    foreignKeyConstraintName:
      'fk_platform_support_requests_target_organization',
  })
  targetOrganization?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  targetUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'target_user_id',
    foreignKeyConstraintName: 'fk_platform_support_requests_target_user',
  })
  targetUser?: { id: string };

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'text' })
  evidence!: string;

  @Column({ type: 'uuid', nullable: true })
  decidedByUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'decided_by_user_id',
    foreignKeyConstraintName: 'fk_platform_support_requests_decided_by',
  })
  decidedBy?: { id: string };

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  decisionNote!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  executedAt!: Date | null;

  // `type` estável do erro de domínio quando a execução falha (status `failed`).
  @Column({ type: 'varchar', length: 100, nullable: true })
  failureType!: string | null;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;
}
