import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { EnrollmentStatus } from '../../domain/enrollment.js';
import { HubTypeormEntity } from './hub.entity.js';

// Apresentação de um Hub sem dono. Só do backend: sem RLS (não é dado de cliente; só a chave/o hash a alcançam)
// e sem sync_version. Vencidas viram `expired` por UPDATE (o runtime não tem DELETE).
@Entity('hub_enrollments')
@Check(
  'ck_hub_enrollments_status',
  `"status" IN ('pending', 'claimed', 'expired')`,
)
@Check(
  'ck_hub_enrollments_claimed_hub',
  `("status" = 'claimed') = ("claimed_hub_id" IS NOT NULL)`,
)
// nonce de uso único por chave, para sempre.
@Index('uq_hub_enrollments_key_nonce', ['signingPublicKey', 'nonce'], {
  unique: true,
})
// Código único entre as pendentes.
@Index('uq_hub_enrollments_claim_code_hash', ['claimCodeHash'], {
  unique: true,
  where: `"status" = 'pending'`,
})
// Uma pendente por chave (spec §5): a apresentação nova expira a anterior antes de gravar.
@Index('uq_hub_enrollments_pending_signing_key', ['signingPublicKey'], {
  unique: true,
  where: `"status" = 'pending'`,
})
@Index('fk_hub_enrollments_hubs_idx', ['claimedHubId'])
export class HubEnrollmentTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'varchar', length: 64 })
  signingPublicKey!: string;

  @Column({ type: 'text' })
  encryptionPublicKey!: string;

  @Column({ type: 'varchar', length: 32 })
  nonce!: string;

  @Column({ type: 'varchar', length: 64 })
  claimCodeHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: EnrollmentStatus;

  @Column({ type: 'uuid', nullable: true })
  claimedHubId!: string | null;

  @ManyToOne(() => HubTypeormEntity)
  @JoinColumn({
    name: 'claimed_hub_id',
    foreignKeyConstraintName: 'fk_hub_enrollments_hubs',
  })
  claimedHub?: HubTypeormEntity;
}
